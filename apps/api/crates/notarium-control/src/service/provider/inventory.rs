use super::{ProviderService, records::*};
use crate::{
    error::invalid,
    store::{
        ReadTransaction, Transaction,
        lease::OperationBudget,
        statements::{page_rows, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    owner: PrincipalId,
    kind: String,
    resource: Option<ProviderResourceId>,
    owner_revision: i64,
    resource_revision: Option<i64>,
    last: String,
}
pub(super) async fn resource_visible(
    tx: &mut Transaction,
    owner: &str,
    row: &ProviderResourcesRow,
) -> Result<(), PortError> {
    if row.owner_id == owner {
        return Ok(());
    }
    let count=rows!(tx,(i64,),fetch_one,
        "SELECT count(*) FROM provider_attachments p JOIN space_members m ON m.space_id=p.target_space AND m.user_id=$2 JOIN space_admission a ON a.space_id=m.space_id WHERE p.resource_id=$1 AND m.admission='active' AND a.state='active' AND (p.target_owner=$2 OR m.role='owner')",
        "SELECT count(*) FROM v1_control.provider_attachments p JOIN v1_control.space_members m ON m.space_id=p.target_space AND m.user_id=$2 JOIN v1_control.space_admission a ON a.space_id=m.space_id WHERE p.resource_id=$1 AND m.admission='active' AND a.state='active' AND (p.target_owner=$2 OR m.role='owner')";&row.id,owner)?.0;
    if count == 0 {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}
impl ProviderService {
    async fn inventory(
        &self,
        ctx: &AccountContext,
        kind: &str,
        id: Option<ProviderResourceId>,
        page: &ControlPageRequest,
    ) -> Result<(ReadTransaction, OperationBudget, Cursor), PortError> {
        let old: Option<Cursor> = page.continuation().map(parse).transpose()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.control.store.read(budget.clone()).await?;
        let cursor = budget
            .run(
                async {
                    let (_, owner) = self
                        .control
                        .manager_read(tx.inner_mut(), ctx.auth(), ctx.auth().principal())
                        .await?;
                    let resource_revision = if let Some(id) = &id {
                        let row = resource_read(tx.inner_mut(), id.as_str()).await?;
                        resource_visible(tx.inner_mut(), &owner.user_id, &row).await?;
                        Some(row.revision)
                    } else {
                        None
                    };
                    if old.as_ref().is_some_and(|old| {
                        old.version != 1
                            || old.owner != *ctx.auth().principal()
                            || old.kind != kind
                            || old.resource != id
                            || old.owner_revision != owner.revision
                            || old.resource_revision != resource_revision
                            || old.last.is_empty()
                            || old.last.len() > 2048
                    }) {
                        return Err(invalid(ValidationReason::CursorStale));
                    }
                    Ok(Cursor {
                        version: 1,
                        owner: ctx.auth().principal().clone(),
                        kind: kind.into(),
                        resource: id,
                        owner_revision: owner.revision,
                        resource_revision,
                        last: old.map_or_else(String::new, |old| old.last),
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        Ok((tx, budget, cursor))
    }
    pub async fn list_credentials(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ProviderCredentialInfo>, PortError> {
        let (mut tx, budget, cursor) = self.inventory(&ctx, "credentials", None, &page).await?;
        let rows=budget.run(async {page_rows!(tx.inner_mut(),CredentialsRow,TargetTable::Credentials,page.limit(),
            "SELECT * FROM credentials WHERE owner_id=$1 AND kind='provider-header-v1' AND id>$2 ORDER BY id LIMIT $3",
            "SELECT * FROM v1_control.credentials WHERE owner_id=$1 AND kind='provider-header-v1' AND id>$2 ORDER BY id LIMIT $3";ctx.auth().principal().as_str(),&cursor.last,i64::from(page.limit())+1)},CommitEffect::NotCommitted).await?;
        let continuation = continuation(
            cursor,
            rows.has_more,
            rows.rows.last().map(|row| row.id.as_str()),
        )?;
        let items = rows
            .rows
            .iter()
            .map(credential_info)
            .collect::<Result<_, _>>()?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(ControlPage {
            items,
            continuation,
        })
    }
    pub async fn list_resources(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ProviderResourceInfo>, PortError> {
        let (mut tx, budget, cursor) = self.inventory(&ctx, "resources", None, &page).await?;
        let rows=budget.run(async {page_rows!(tx.inner_mut(),ProviderResourcesRow,TargetTable::ProviderResources,page.limit(),
            "SELECT * FROM provider_resources WHERE owner_id=$1 AND id>$2 ORDER BY id LIMIT $3",
            "SELECT * FROM v1_control.provider_resources WHERE owner_id=$1 AND id>$2 ORDER BY id LIMIT $3";ctx.auth().principal().as_str(),&cursor.last,i64::from(page.limit())+1)},CommitEffect::NotCommitted).await?;
        let continuation = continuation(
            cursor,
            rows.has_more,
            rows.rows.last().map(|row| row.id.as_str()),
        )?;
        let items = rows
            .rows
            .iter()
            .map(resource_info)
            .collect::<Result<_, _>>()?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(ControlPage {
            items,
            continuation,
        })
    }
    pub async fn list_models(
        &self,
        ctx: AccountContext,
        id: ProviderResourceId,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ProviderModelInfo>, PortError> {
        let (mut tx, budget, cursor) = self
            .inventory(&ctx, "models", Some(id.clone()), &page)
            .await?;
        let rows=budget.run(async {page_rows!(tx.inner_mut(),ProviderModelsRow,TargetTable::ProviderModels,page.limit(),
            "SELECT * FROM provider_models WHERE resource_id=$1 AND model_id>$2 ORDER BY model_id LIMIT $3",
            "SELECT * FROM v1_control.provider_models WHERE resource_id=$1 AND model_id>$2 ORDER BY model_id LIMIT $3";id.as_str(),&cursor.last,i64::from(page.limit())+1)},CommitEffect::NotCommitted).await?;
        let continuation = continuation(
            cursor,
            rows.has_more,
            rows.rows.last().map(|row| row.model_id.as_str()),
        )?;
        let items = rows.rows.iter().map(model_info).collect::<Result<_, _>>()?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(ControlPage {
            items,
            continuation,
        })
    }
    pub async fn list_attachments(
        &self,
        ctx: AccountContext,
        id: ProviderResourceId,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ProviderAttachmentInfo>, PortError> {
        let (mut tx, budget, cursor) = self
            .inventory(&ctx, "attachments", Some(id.clone()), &page)
            .await?;
        let rows=budget.run(async {page_rows!(tx.inner_mut(),ProviderAttachmentsRow,TargetTable::ProviderAttachments,page.limit(),
            "SELECT p.* FROM provider_attachments p JOIN provider_resources r ON r.id=p.resource_id WHERE p.resource_id=$1 AND p.id>$2 AND (r.owner_id=$3 OR EXISTS (SELECT 1 FROM space_members m JOIN space_admission a ON a.space_id=m.space_id WHERE m.space_id=p.target_space AND m.user_id=$3 AND m.admission='active' AND a.state='active' AND (p.target_owner=$3 OR m.role='owner'))) ORDER BY p.id LIMIT $4",
            "SELECT p.* FROM v1_control.provider_attachments p JOIN v1_control.provider_resources r ON r.id=p.resource_id WHERE p.resource_id=$1 AND p.id>$2 AND (r.owner_id=$3 OR EXISTS (SELECT 1 FROM v1_control.space_members m JOIN v1_control.space_admission a ON a.space_id=m.space_id WHERE m.space_id=p.target_space AND m.user_id=$3 AND m.admission='active' AND a.state='active' AND (p.target_owner=$3 OR m.role='owner'))) ORDER BY p.id LIMIT $4";id.as_str(),&cursor.last,ctx.auth().principal().as_str(),i64::from(page.limit())+1)},CommitEffect::NotCommitted).await?;
        let continuation = continuation(
            cursor,
            rows.has_more,
            rows.rows.last().map(|row| row.id.as_str()),
        )?;
        let items = rows
            .rows
            .iter()
            .map(attachment_info)
            .collect::<Result<_, _>>()?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(ControlPage {
            items,
            continuation,
        })
    }
    pub async fn inspect_attachment(
        &self,
        ctx: AccountContext,
        id: RequestId,
    ) -> Result<ProviderAttachmentReview, PortError> {
        let observed = self.observe_attachment(&ctx, &id).await?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.control.store.read(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let (_, owner) = self
                        .control
                        .manager_read(tx.inner_mut(), ctx.auth(), ctx.auth().principal())
                        .await?;
                    let space = SpaceId::parse(&observed.target_space)?;
                    let resource = resource_read(tx.inner_mut(), &observed.resource_id).await?;
                    let row = attachment_read(tx.inner_mut(), id.as_str()).await?;
                    if row.resource_id != resource.id
                        || attachment_target(&row)? != attachment_target(&observed)?
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    if resource.owner_id != owner.user_id {
                        super::attachments::check_member(tx.inner_mut(), ctx.auth(), &space)
                            .await?;
                        if row.target_owner.as_deref() != Some(owner.user_id.as_str()) {
                            super::super::spaces::require_owner_read(
                                tx.inner_mut(),
                                ctx.auth(),
                                &space,
                            )
                            .await?;
                        }
                    }
                    let current_credential_consent_epoch = if let Some(id) = &resource.credential_id
                    {
                        Some(credential_read(tx.inner_mut(), id).await?.consent_epoch as u64)
                    } else {
                        None
                    };
                    Ok(ProviderAttachmentReview {
                        attachment: attachment_info(&row)?,
                        resource: resource_info(&resource)?,
                        current_credential_consent_epoch,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(result)
    }
}
fn continuation(
    mut cursor: Cursor,
    more: bool,
    last: Option<&str>,
) -> Result<Option<String>, PortError> {
    if !more {
        return Ok(None);
    }
    cursor.last = last
        .ok_or_else(|| invalid(ValidationReason::InvalidState))?
        .into();
    Ok(Some(json(&cursor)?))
}
