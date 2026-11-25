use super::super::{
    authority::next,
    commands::Command,
    spaces::{admission, require_owner},
};
use super::{ProviderService, SearchDefaultWitness, records::*};
use crate::{
    error::invalid,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, Space, SpaceKind, SpaceLifecycle},
    classes::DocClass,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::{control::*, *},
};

pub(super) fn disclosure(value: &ProviderDisclosure, kind: SpaceKind) -> Result<(), PortError> {
    if value.classes.is_empty()
        || value.classes.contains(&DocClass::EncryptedNote)
        || (kind == SpaceKind::Shared && value.classes.contains(&DocClass::Profile))
    {
        return Err(DomainError::AccessDenied.into());
    }
    Ok(())
}
/// Acquire Space admission before any provider configuration row locks. An
/// absent admission is not authority; check_member rejects it for member access.
/// Resource owners can still inspect their own records after Space removal.
pub(super) async fn lock_space_read(
    tx: &mut Transaction,
    space: &SpaceId,
) -> Result<(), PortError> {
    rows!(tx, (String,), fetch_optional,
        "SELECT space_id FROM space_admission WHERE space_id=$1",
        "SELECT space_id FROM v1_control.space_admission WHERE space_id=$1 FOR SHARE";
        space.as_str())?;
    Ok(())
}

/// Growing the set of eligible project preferences can retire another
/// provider's implicit calls. Serialize activation with final dispatch and
/// compare the effective recipient in the same transaction as the grant.
async fn before_attachment(
    tx: &mut Transaction,
    target: &ProviderAttachmentTarget,
    space: &Space,
    approving: bool,
    clock: &dyn super::super::ControlClock,
) -> Result<Option<SearchDefaultWitness>, PortError> {
    let activates = match target {
        ProviderAttachmentTarget::Personal { .. } => space.kind == SpaceKind::Personal,
        _ => approving && space.kind == SpaceKind::Shared,
    };
    if activates {
        admission(tx, &space.id, true).await?;
        SearchDefaultWitness::capture(tx, space, clock.now_ms()?).await
    } else {
        lock_space_read(tx, &space.id).await?;
        Ok(None)
    }
}

/// Check eligibility while the caller holds Space admission from revalidation,
/// lock_space_read, or an exclusive scope mutation lock. Never upgrade a lock
/// here: provider policy runs after resource locks have already been acquired.
pub(super) async fn check_member(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    space: &SpaceId,
) -> Result<(), PortError> {
    if !auth.spaces().contains_key(space) {
        return Err(DomainError::AccessDenied.into());
    }
    let current = admission(tx, space, false).await?;
    if current.state != "active" {
        return Err(DomainError::AccessDenied.into());
    }
    let live=rows!(tx,(i64,),fetch_one,"SELECT count(*) FROM space_members WHERE space_id=$1 AND user_id=$2 AND admission='active'","SELECT count(*) FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2 AND admission='active'";space.as_str(),auth.principal().as_str())?.0;
    if live != 1 {
        return Err(DomainError::AccessDenied.into());
    }
    Ok(())
}
pub(super) async fn check_member_for_target(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    target: &ProviderAttachmentTarget,
) -> Result<(), PortError> {
    let space = target_space(target);
    let grant = auth.spaces().get(space).ok_or(DomainError::AccessDenied)?;
    match target {
        ProviderAttachmentTarget::Personal { .. } | ProviderAttachmentTarget::Space(_) => {
            if grant.project_root.is_some() {
                return Err(DomainError::AccessDenied.into());
            }
        }
        ProviderAttachmentTarget::Project(project) => {
            if grant
                .project_root
                .as_ref()
                .is_some_and(|root| root != &project.folder_id)
            {
                return Err(DomainError::AccessDenied.into());
            }
        }
    }
    let current = admission(tx, space, false).await?;
    if current.state != "active" {
        return Err(DomainError::AccessDenied.into());
    }
    let live=rows!(tx,(i64,),fetch_one,"SELECT count(*) FROM space_members WHERE space_id=$1 AND user_id=$2 AND admission='active'","SELECT count(*) FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2 AND admission='active'";space.as_str(),auth.principal().as_str())?.0;
    if live != 1 {
        return Err(DomainError::AccessDenied.into());
    }
    Ok(())
}
pub(super) async fn epochs(
    tx: &mut Transaction,
    resource: &ProviderResourcesRow,
) -> Result<Option<i64>, PortError> {
    if resource.disabled_at.is_some() {
        return Err(DomainError::AccessDenied.into());
    }
    if let Some(id) = &resource.credential_id {
        let credential = credential(tx, id).await?;
        owned(&resource.owner_id, &credential.owner_id)?;
        if credential.disabled_at.is_some() {
            return Err(DomainError::AccessDenied.into());
        }
        Ok(Some(credential.consent_epoch))
    } else {
        Ok(None)
    }
}
pub(super) async fn credential_for_selection(
    tx: &mut Transaction,
    resource: &ProviderResourcesRow,
) -> Result<Option<CredentialsRow>, PortError> {
    if resource.disabled_at.is_some() {
        return Err(DomainError::AccessDenied.into());
    }
    if let Some(id) = &resource.credential_id {
        let credential = credential_read(tx, id).await?;
        owned(&resource.owner_id, &credential.owner_id)?;
        if credential.disabled_at.is_some() {
            return Err(DomainError::AccessDenied.into());
        }
        Ok(Some(credential))
    } else {
        Ok(None)
    }
}
pub(super) async fn bump(
    tx: &mut Transaction,
    resource: &ProviderResourcesRow,
) -> Result<(), PortError> {
    execute!(tx,"UPDATE provider_resources SET revision=$1,runtime_epoch=$2 WHERE id=$3","UPDATE v1_control.provider_resources SET revision=$1,runtime_epoch=$2 WHERE id=$3";next(resource.revision)?,next(resource.runtime_epoch)?,&resource.id)?;
    Ok(())
}
impl ProviderService {
    pub(super) async fn target_catalog(
        &self,
        ctx: &AccountContext,
        target: &ProviderAttachmentTarget,
    ) -> Result<CatalogSpace, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let id = target_space(target);
        let grant = ctx
            .auth()
            .spaces()
            .get(id)
            .ok_or(DomainError::AccessDenied)?;
        if let ProviderAttachmentTarget::Project(project) = target
            && grant
                .project_root
                .as_ref()
                .is_some_and(|root| root != &project.folder_id)
        {
            return Err(DomainError::AccessDenied.into());
        }
        let space = budget
            .run(
                self.control
                    .catalog
                    .space(budget.context(ctx.budget.request.clone()), id.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        if space.space.id != *id
            || space.history.space_id != *id
            || space.space.lifecycle != SpaceLifecycle::Active
        {
            return Err(DomainError::AccessDenied.into());
        }
        if let ProviderAttachmentTarget::Project(project) = target {
            let context = SpaceContext::new(
                ctx.auth().clone(),
                space.history.clone(),
                budget.context(ctx.budget.request.clone()),
            )?;
            let current = budget
                .run(
                    self.control.catalog.project(context, project.clone()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            if current.folder != *project {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
        Ok(space)
    }
    pub(super) async fn observe_attachment(
        &self,
        ctx: &AccountContext,
        id: &RequestId,
    ) -> Result<ProviderAttachmentsRow, PortError> {
        OperationBudget::new(ctx.budget.clone())
            .run(
                async {
                    read_rows!(
                        &self.control.store.backend,
                        ProviderAttachmentsRow,
                        fetch_optional,
                        "SELECT * FROM provider_attachments WHERE id=$1",
                        "SELECT * FROM v1_control.provider_attachments WHERE id=$1";
                        id.as_str()
                    )?
                    .ok_or(DomainError::ResourceNotFound.into())
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
    fn observe_attachment_authorized<'a>(
        &'a self,
        ctx: &'a AccountContext,
        id: &'a RequestId,
        allow_resource_owner: bool,
    ) -> PortFuture<'a, ProviderAttachmentsRow> {
        Box::pin(async move {
            let budget = OperationBudget::new(ctx.budget.clone());
            let (mut tx, auth) = self
                .control
                .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
                .await?;
            let result = budget
                .run(
                    async {
                        let row = rows!(
                            tx.inner_mut(),
                            ProviderAttachmentsRow,
                            fetch_optional,
                            "SELECT * FROM provider_attachments WHERE id=$1",
                            "SELECT * FROM v1_control.provider_attachments WHERE id=$1";
                            id.as_str()
                        )?
                        .ok_or(DomainError::AccessDenied)?;
                        let target = attachment_target(&row)?;
                        let resource_owner = if allow_resource_owner {
                            rows!(
                                tx.inner_mut(),
                                (String,),
                                fetch_optional,
                                "SELECT owner_id FROM provider_resources WHERE id=$1",
                                "SELECT owner_id FROM v1_control.provider_resources WHERE id=$1";
                                &row.resource_id
                            )?
                            .is_some_and(|(owner_id,)| owner_id == auth.principal().as_str())
                        } else {
                            false
                        };
                        if !resource_owner {
                            match &target {
                                ProviderAttachmentTarget::Personal { owner, .. } => {
                                    if owner != auth.principal() {
                                        return Err(DomainError::AccessDenied.into());
                                    }
                                    if !allow_resource_owner {
                                        check_member_for_target(tx.inner_mut(), &auth, &target)
                                            .await
                                            .map_err(|_| {
                                                PortError::Domain(DomainError::AccessDenied)
                                            })?;
                                    }
                                }
                                _ => {
                                    if !auth.spaces().contains_key(target_space(&target)) {
                                        return Err(DomainError::AccessDenied.into());
                                    }
                                    let is_owner = rows!(
                                        tx.inner_mut(),
                                        (i64,),
                                        fetch_one,
                                        "SELECT count(*) FROM space_members WHERE space_id=$1 AND user_id=$2 AND role='owner' AND admission='active'",
                                        "SELECT count(*) FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2 AND role='owner' AND admission='active'";
                                        target_space(&target).as_str(),
                                        auth.principal().as_str()
                                    )?
                                    .0;
                                    if is_owner != 1 {
                                        return Err(DomainError::AccessDenied.into());
                                    }
                                }
                            }
                        }
                        Ok(row)
                    },
                    CommitEffect::NotCommitted,
                )
                .await;
            budget
                .run(tx.rollback(), CommitEffect::NotCommitted)
                .await?;
            result
        })
    }
    pub async fn request_attachment(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<RequestProviderAttachment>,
    ) -> Result<ControlCommit<ProviderAttachmentInfo>, PortError> {
        let input = request.input;
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management_scoped(&ctx).await?;
        let catalog = self.target_catalog(&ctx, &input.target).await?;
        disclosure(input.consent.disclosure(), catalog.space.kind)?;
        let command = Command::new(
            request.identity,
            "request-provider-attachment",
            (
                &input.id,
                input.expected,
                &input.resource,
                input.resource_consent_epoch,
                input.credential_consent_epoch,
                &input.target,
                input.consent.disclosure(),
                input.expires_at_ms,
            ),
        )?;
        let auth = ctx.auth().clone();
        let auth_check = auth.clone();
        let target_check = input.target.clone();
        let space_check = catalog.space.clone();
        let clock = self.control.clock.clone();
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate_authorized_scoped(
            ctx,
            command,
            move |tx, owner| {
                Box::pin(async move {
                    let activates = matches!(
                        target_check,
                        ProviderAttachmentTarget::Personal { .. }
                    ) && space_check.kind == SpaceKind::Personal;
                    if activates {
                        admission(tx, &space_check.id, true).await?;
                    } else {
                        lock_space_read(tx, &space_check.id).await?;
                    }
                    check_member_for_target(tx, &auth_check, &target_check).await?;
                    if let ProviderAttachmentTarget::Personal {
                        owner: target_owner,
                        ..
                    } = &target_check
                    {
                        owned(&owner.user_id, target_owner.as_str())?;
                    }
                    Ok(())
                })
            },
            move |tx,owner,now|Box::pin(async move {
            if input.expires_at_ms.is_some_and(|expires| expires<=now || expires.saturating_sub(now)>365*24*60*60*1000) {return Err(invalid(ValidationReason::InvalidTimestamp));}
            let space=target_space(&input.target);
            let previous=before_attachment(tx, &input.target, &catalog.space, false, clock.as_ref()).await?;check_member_for_target(tx,&auth,&input.target).await?;
            let resource=resource(tx,input.resource.as_str()).await?;let credential_epoch=epochs(tx,&resource).await?;
            if input.resource_consent_epoch!=resource.consent_epoch as u64 || input.credential_consent_epoch!=credential_epoch.map(|epoch|epoch as u64) {return Err(DomainError::AccessDenied.into());}
            let (kind,target_owner,target_project,state)=match &input.target {
                ProviderAttachmentTarget::Personal{owner:target_owner,..}=>{
                    owned(&owner.user_id,target_owner.as_str())?;
                    // An individual may consent to an offered shared resource,
                    // but cannot discover or attach an unrelated private one.
                    if resource.owner_id!=owner.user_id {
                        let offered=rows!(tx,(i64,),fetch_one,"SELECT count(*) FROM provider_attachments WHERE resource_id=$1 AND target_space=$2 AND target_kind IN ('space','project') AND state='approved' AND resource_epoch=$3 AND (expires_at IS NULL OR expires_at>$4)","SELECT count(*) FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_space=$2 AND target_kind IN ('space','project') AND state='approved' AND resource_epoch=$3 AND (expires_at IS NULL OR expires_at>$4)";&resource.id,space.as_str(),resource.consent_epoch,now)?.0;
                        if offered==0 {return Err(DomainError::ResourceNotFound.into());}
                    }
                    ("personal",Some(target_owner.to_string()),None,"approved")
                },
                ProviderAttachmentTarget::Space(_)=>{owned(&owner.user_id,&resource.owner_id)?;("space",None,None,"pending")},
                ProviderAttachmentTarget::Project(project)=>{owned(&owner.user_id,&resource.owner_id)?;("project",None,Some(project.folder_id.to_string()),"pending")},
            };
            let old=rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE id=$1","SELECT * FROM v1_control.provider_attachments WHERE id=$1";input.id.as_str())?;
            let rev=if let Some(old)=&old {
                if old.resource_id!=resource.id || attachment_target(old)?!=input.target {return Err(DomainError::AccessDenied.into());}
                revision(old.revision,input.expected.ok_or_else(||invalid(ValidationReason::InvalidState))?)?;next(old.revision)?
            } else {if input.expected.is_some(){return Err(DomainError::ResourceNotFound.into());} 0};
            let row=ProviderAttachmentsRow{id:input.id.to_string(),resource_id:resource.id.clone(),target_kind:kind.into(),target_owner,target_space:space.to_string(),target_project,resource_epoch:resource.consent_epoch,credential_epoch,state:state.into(),disclosure:json(input.consent.disclosure())?,expires_at:input.expires_at_ms,revision:rev};
            TargetRecord::from(row.clone()).validate()?;
            if old.is_some() {
                execute!(tx,"UPDATE provider_attachments SET resource_epoch=$1,credential_epoch=$2,state=$3,disclosure=$4,expires_at=$5,revision=$6 WHERE id=$7","UPDATE v1_control.provider_attachments SET resource_epoch=$1,credential_epoch=$2,state=$3,disclosure=$4,expires_at=$5,revision=$6 WHERE id=$7";row.resource_epoch,row.credential_epoch,&row.state,&row.disclosure,row.expires_at,row.revision,&row.id)?;
            } else {TargetRecord::from(row.clone()).insert_or_conflict(tx).await?;}
            bump(tx,&resource).await?;
            let mut selectors = vec![RevocationSelector::ProviderResource(input.resource)];
            if let Some(previous) = previous { selectors.extend(previous.changed(tx, clock.now_ms()?).await?); }
            Ok((attachment_info(&row)?,selectors))
        })).await
    }
    pub async fn approve_attachment(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<ApproveProviderAttachment>,
    ) -> Result<ControlCommit<ProviderAttachmentInfo>, PortError> {
        let input = request.input;
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management(&ctx).await?;
        let observed = self
            .observe_attachment_authorized(&ctx, &input.id, false)
            .await?;
        let target = attachment_target(&observed)?;
        let catalog = self.target_catalog(&ctx, &target).await?;
        disclosure(input.consent.disclosure(), catalog.space.kind)?;
        let command = Command::new(
            request.identity,
            "approve-provider-attachment",
            (
                &input.id,
                input.expected,
                input.resource_consent_epoch,
                input.credential_consent_epoch,
                input.consent.disclosure(),
            ),
        )?;
        let auth = ctx.auth().clone();
        let auth_check = auth.clone();
        let target_check = target.clone();
        let space_check = catalog.space.clone();
        let clock = self.control.clock.clone();
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate_authorized(
            ctx,
            command,
            move |tx, owner| {
                Box::pin(async move {
                    let activates = !matches!(
                        target_check,
                        ProviderAttachmentTarget::Personal { .. }
                    ) && space_check.kind == SpaceKind::Shared;
                    if activates {
                        admission(tx, &space_check.id, true).await?;
                    } else {
                        lock_space_read(tx, &space_check.id).await?;
                    }
                    check_member_for_target(tx, &auth_check, &target_check).await?;
                    match &target_check {
                        ProviderAttachmentTarget::Personal {
                            owner: target_owner,
                            ..
                        } => owned(&owner.user_id, target_owner.as_str())?,
                        _ => require_owner(tx, &auth_check, target_space(&target_check)).await?,
                    }
                    Ok(())
                })
            },
            move |tx,owner,now|Box::pin(async move {
            let previous=before_attachment(tx, &target, &catalog.space, true, clock.as_ref()).await?;
            check_member_for_target(tx,&auth,&target).await?;
            match &target {ProviderAttachmentTarget::Personal{owner:target_owner,..}=>owned(&owner.user_id,target_owner.as_str())?,_=>require_owner(tx,&auth,target_space(&target)).await?};
            let resource=resource(tx,&observed.resource_id).await?;let credential_epoch=epochs(tx,&resource).await?;
            let mut row=attachment(tx,input.id.as_str()).await?;revision(row.revision,input.expected)?;
            if row.resource_id!=resource.id || attachment_target(&row)?!=target || row.expires_at.is_some_and(|time|time<=now) || row.state=="revoked" || row.resource_epoch!=resource.consent_epoch || row.credential_epoch!=credential_epoch || input.resource_consent_epoch!=resource.consent_epoch as u64 || input.credential_consent_epoch!=credential_epoch.map(|epoch|epoch as u64) || parse::<ProviderDisclosure>(&row.disclosure)?!=*input.consent.disclosure() {return Err(DomainError::AccessDenied.into());}
            row.state="approved".into();row.revision=next(row.revision)?;
            execute!(tx,"UPDATE provider_attachments SET state='approved',revision=$1 WHERE id=$2","UPDATE v1_control.provider_attachments SET state='approved',revision=$1 WHERE id=$2";row.revision,&row.id)?;
            bump(tx,&resource).await?;
            let mut selectors = vec![RevocationSelector::ProviderResource(ProviderResourceId::parse(&resource.id)?)];
            if let Some(previous) = previous { selectors.extend(previous.changed(tx, clock.now_ms()?).await?); }
            Ok((attachment_info(&row)?,selectors))
        })).await
    }
    pub async fn revoke_attachment(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<RevokeProviderAttachment>,
    ) -> Result<ControlCommit<()>, PortError> {
        let input = request.input;
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management(&ctx).await?;
        let observed = self
            .observe_attachment_authorized(&ctx, &input.id, true)
            .await?;
        let target = attachment_target(&observed)?;
        let command = Command::new(
            request.identity,
            "revoke-provider-attachment",
            (&input.id, input.expected),
        )?;
        let auth = ctx.auth().clone();
        let auth_check = auth.clone();
        let target_check = target.clone();
        let resource_id_check = observed.resource_id.clone();
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate_authorized(
            ctx,
            command,
            move |tx, owner| {
                Box::pin(async move {
                    lock_space_read(tx, target_space(&target_check)).await?;
                    let resource = resource(tx, &resource_id_check).await?;
                    if resource.owner_id != owner.user_id {
                        match &target_check {
                            ProviderAttachmentTarget::Personal {
                                owner: target_owner,
                                ..
                            } => owned(&owner.user_id, target_owner.as_str())?,
                            _ => {
                                check_member(tx, &auth_check, target_space(&target_check)).await?;
                                require_owner(tx, &auth_check, target_space(&target_check)).await?;
                            }
                        }
                    }
                    Ok(())
                })
            },
            move |tx,owner,_|Box::pin(async move {
            let resource=resource(tx,&observed.resource_id).await?;
            if resource.owner_id!=owner.user_id {
                match &target {ProviderAttachmentTarget::Personal{owner:target_owner,..}=>owned(&owner.user_id,target_owner.as_str())?,_=>require_owner(tx,&auth,target_space(&target)).await?};
            }
            let row=attachment(tx,input.id.as_str()).await?;revision(row.revision,input.expected)?;
            if row.resource_id!=resource.id || attachment_target(&row)?!=target {return Err(DomainError::AccessDenied.into());}
            execute!(tx,"UPDATE provider_attachments SET state='revoked',revision=$1 WHERE id=$2","UPDATE v1_control.provider_attachments SET state='revoked',revision=$1 WHERE id=$2";next(row.revision)?,&row.id)?;
            bump(tx,&resource).await?;
            Ok(((),vec![RevocationSelector::ProviderResource(ProviderResourceId::parse(&resource.id)?)]))
        })).await
    }
}
