//! Read-only, Space-scoped disclosure metadata before a sender's first consent.
pub(crate) const LIST_OFFERS_PROJECT_PINNED_SQLITE_SQL: &str = "SELECT p.* FROM provider_attachments p INDEXED BY attachment_target_project_approved_id CROSS JOIN provider_resources r CROSS JOIN users u LEFT JOIN credentials c ON c.id=r.credential_id WHERE r.id=p.resource_id AND u.user_id=r.owner_id AND p.target_space=$1 AND p.target_kind='project' AND p.target_project=$2 AND p.id>$3 AND p.state='approved' AND (p.expires_at IS NULL OR p.expires_at>$4) AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND p.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND p.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND p.credential_epoch=c.consent_epoch)) ORDER BY p.id LIMIT $5";
pub(crate) const LIST_OFFERS_SPACE_SQLITE_SQL: &str = "SELECT p.* FROM provider_attachments p INDEXED BY attachment_target_approved_id CROSS JOIN provider_resources r CROSS JOIN users u LEFT JOIN credentials c ON c.id=r.credential_id WHERE r.id=p.resource_id AND u.user_id=r.owner_id AND p.target_space=$1 AND (p.target_kind='space' OR (p.target_kind='project' AND p.target_project=$2)) AND p.id>$3 AND p.state='approved' AND (p.expires_at IS NULL OR p.expires_at>$4) AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND p.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND p.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND p.credential_epoch=c.consent_epoch)) ORDER BY p.id LIMIT $5";
use super::{ProviderService, attachments, records::*};
use crate::{
    error::invalid,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{page_rows, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::SpaceKind,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::FolderRef,
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OfferCursor {
    version: u8,
    access: ContentDigest,
    last: String,
}
fn position(page: &ControlPageRequest, access: &ContentDigest) -> Result<String, PortError> {
    let Some(value) = page.continuation() else {
        return Ok(String::new());
    };
    let cursor: OfferCursor = parse(value)?;
    if cursor.version != 1
        || cursor.access != *access
        || cursor.last.is_empty()
        || cursor.last.len() > 2048
    {
        return Err(invalid(ValidationReason::CursorStale));
    }
    Ok(cursor.last)
}
fn continuation(
    access: ContentDigest,
    more: bool,
    last: Option<String>,
) -> Result<Option<String>, PortError> {
    if !more {
        return Ok(None);
    }
    Ok(Some(json(&OfferCursor {
        version: 1,
        access,
        last: last.ok_or_else(|| invalid(ValidationReason::InvalidState))?,
    })?))
}

impl ProviderService {
    async fn offer_catalog(
        &self,
        ctx: &SpaceContext,
        project: &Option<FolderRef>,
    ) -> Result<CatalogSpace, PortError> {
        if project
            .as_ref()
            .is_some_and(|p| p.space_id != ctx.scope().space_id)
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let account = AccountContext::new(ctx.auth().clone(), ctx.budget.clone());
        self.management_read_scoped(&account).await?;
        let target = project.as_ref().map_or_else(
            || ProviderAttachmentTarget::Space(ctx.scope().space_id.clone()),
            |project| ProviderAttachmentTarget::Project(project.clone()),
        );
        let catalog = self.target_catalog(&account, &target).await?;
        ctx.check_current(&catalog.history)?;
        Ok(catalog)
    }

    async fn offer_caller_access(
        &self,
        tx: &mut Transaction,
        ctx: &SpaceContext,
    ) -> Result<
        (
            notarium_core::auth::EngineAuthContext,
            notarium_core::auth::SpaceGrant,
            i64,
            i64,
            i64,
        ),
        PortError,
    > {
        let (_, owner) = self
            .control
            .scoped_manager_read(tx, ctx.auth(), ctx.auth().principal())
            .await?;
        let auth = self.control.revalidate_read(tx, ctx.auth()).await?;
        let grant = auth
            .spaces()
            .get(&ctx.scope().space_id)
            .ok_or(DomainError::ResourceNotFound)?
            .clone();
        if grant.read_classes.is_empty() {
            return Err(DomainError::ResourceNotFound.into());
        }
        // Revalidation already holds shared membership and Space locks. A
        // read-only listing must not upgrade them through the mutation helper.
        let space = super::super::spaces::admission(tx, &ctx.scope().space_id, false).await?;
        if space.state != "active" {
            return Err(DomainError::ResourceNotFound.into());
        }
        let membership = rows!(tx, (i64,), fetch_optional,
            "SELECT revision FROM space_members WHERE space_id=$1 AND user_id=$2 AND admission='active'",
            "SELECT revision FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2 AND admission='active'";
            ctx.scope().space_id.as_str(), auth.principal().as_str())?
        .ok_or(DomainError::ResourceNotFound)?
        .0;
        Ok((auth, grant, owner.revision, space.revision, membership))
    }

    async fn offer_access(
        &self,
        tx: &mut Transaction,
        ctx: &SpaceContext,
        project: Option<&FolderRef>,
        filter: impl Serialize,
    ) -> Result<ContentDigest, PortError> {
        let (auth, grant, owner_revision, space_revision, membership) =
            self.offer_caller_access(tx, ctx).await?;
        if grant
            .project_root
            .as_ref()
            .is_some_and(|root| project.map(|p| &p.folder_id) != Some(root))
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let bytes = serde_json::to_vec(&(
            "provider-offers-v1",
            auth.principal(),
            auth.grant(),
            ctx.scope(),
            owner_revision,
            space_revision,
            membership,
            grant.role,
            &grant.read_classes,
            &grant.write_classes,
            &grant.project_root,
            filter,
        ))
        .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
        Ok(ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes()))
    }

    // These are metadata snapshots, not dispatch authority. Metadata reads do
    // not lock configuration rows. Confirmation and dispatch separately compare
    // the reviewed versions under their own authority locks.
    async fn offered_review_without_kind(
        &self,
        tx: &mut Transaction,
        row: &ProviderAttachmentsRow,
    ) -> Result<Option<ProviderAttachmentReview>, PortError> {
        let now = self.control.clock.now_ms()?;
        if !matches!(row.target_kind.as_str(), "space" | "project")
            || row.state != "approved"
            || row.expires_at.is_some_and(|expires| expires <= now)
        {
            return Ok(None);
        }
        let resource = rows!(tx, ProviderResourcesRow, fetch_optional,
            "SELECT * FROM provider_resources WHERE id=$1",
            "SELECT * FROM v1_control.provider_resources WHERE id=$1"; &row.resource_id)?;
        let Some(resource) = resource else {
            return Ok(None);
        };
        if resource.disabled_at.is_some() || resource.consent_epoch != row.resource_epoch {
            return Ok(None);
        }
        let owner_active = rows!(tx, (i64,), fetch_one,
            "SELECT count(*) FROM users WHERE user_id=$1 AND disabled_at IS NULL",
            "SELECT count(*) FROM v1_control.users WHERE user_id=$1 AND disabled_at IS NULL"; &resource.owner_id)?.0;
        if owner_active != 1 {
            return Ok(None);
        }
        let credential_epoch = if let Some(id) = &resource.credential_id {
            let credential = rows!(tx, CredentialsRow, fetch_optional,
                "SELECT * FROM credentials WHERE id=$1 AND kind='provider-header-v1'",
                "SELECT * FROM v1_control.credentials WHERE id=$1 AND kind='provider-header-v1'"; id)?;
            let Some(credential) = credential else {
                return Ok(None);
            };
            if credential.disabled_at.is_some() || credential.owner_id != resource.owner_id {
                return Ok(None);
            }
            Some(credential.consent_epoch)
        } else {
            None
        };
        if row.credential_epoch != credential_epoch {
            return Ok(None);
        }
        let attachment = attachment_info(row)?;
        Ok(Some(ProviderAttachmentReview {
            attachment,
            resource: resource_info(&resource)?,
            current_credential_consent_epoch: credential_epoch.map(|epoch| epoch as u64),
        }))
    }

    async fn offered_review(
        &self,
        tx: &mut Transaction,
        row: &ProviderAttachmentsRow,
        kind: SpaceKind,
    ) -> Result<Option<ProviderAttachmentReview>, PortError> {
        let Some(review) = self.offered_review_without_kind(tx, row).await? else {
            return Ok(None);
        };
        if attachments::disclosure(&review.attachment.disclosure, kind).is_err() {
            return Ok(None);
        }
        Ok(Some(review))
    }

    pub async fn list_offers(
        &self,
        mut ctx: SpaceContext,
        query: ProviderOfferQuery,
    ) -> Result<ControlPage<ProviderAttachmentReview>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        ctx.budget = budget.context(ctx.budget.request.clone());
        if query
            .project
            .as_ref()
            .is_some_and(|p| p.space_id != ctx.scope().space_id)
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        // Revalidate caller membership and Space admission before probing live
        // canonical Space/project history.
        let mut pre_tx = self.control.store.read(budget.clone()).await?;
        let pre_access = budget
            .run(
                self.offer_access(
                    pre_tx.inner_mut(),
                    &ctx,
                    query.project.as_ref(),
                    ("offers", &query.project),
                ),
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(pre_tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        pre_access?;
        let catalog = self.offer_catalog(&ctx, &query.project).await?;
        let mut tx = self.control.store.read(budget.clone()).await?;
        let result = budget.run(async {
            let access = self
                .offer_access(
                    tx.inner_mut(),
                    &ctx,
                    query.project.as_ref(),
                    ("offers", &query.project),
                )
                .await?;
            let last = position(&query.page, &access)?;
            let project = query.project.as_ref().map(|project| project.folder_id.as_str());
            let project_pinned = ctx
                .auth()
                .spaces()
                .get(&ctx.scope().space_id)
                .is_some_and(|grant| grant.project_root.is_some());
            let now = self.control.clock.now_ms()?;
            let page = if project_pinned {
                page_rows!(tx.inner_mut(), ProviderAttachmentsRow, TargetTable::ProviderAttachments, query.page.limit(),
                    LIST_OFFERS_PROJECT_PINNED_SQLITE_SQL,
                    "SELECT p.* FROM v1_control.provider_attachments p JOIN v1_control.provider_resources r ON r.id=p.resource_id JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id WHERE p.target_space=$1 AND p.target_kind='project' AND p.target_project=$2 AND p.id>$3 AND p.state='approved' AND (p.expires_at IS NULL OR p.expires_at>$4) AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND p.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND p.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND p.credential_epoch=c.consent_epoch)) ORDER BY p.id LIMIT $5";
                    ctx.scope().space_id.as_str(), project, &last, now, i64::from(query.page.limit())+1)?
            } else {
                page_rows!(tx.inner_mut(), ProviderAttachmentsRow, TargetTable::ProviderAttachments, query.page.limit(),
                    LIST_OFFERS_SPACE_SQLITE_SQL,
                    "SELECT p.* FROM v1_control.provider_attachments p JOIN v1_control.provider_resources r ON r.id=p.resource_id JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id WHERE p.target_space=$1 AND (p.target_kind='space' OR (p.target_kind='project' AND p.target_project=$2)) AND p.id>$3 AND p.state='approved' AND (p.expires_at IS NULL OR p.expires_at>$4) AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND p.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND p.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND p.credential_epoch=c.consent_epoch)) ORDER BY p.id LIMIT $5";
                    ctx.scope().space_id.as_str(), project, &last, now, i64::from(query.page.limit())+1)?
            };
            let last = page.rows.last().map(|row| row.id.clone());
            let mut items = Vec::with_capacity(page.rows.len());
            for row in &page.rows {
                if let Some(review) = self.offered_review(tx.inner_mut(), row, catalog.space.kind).await? {
                    items.push(review);
                }
            }
            Ok(ControlPage { items, continuation: continuation(access, page.has_more, last)? })
        }, CommitEffect::NotCommitted).await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(result)
    }

    pub async fn list_offer_models(
        &self,
        mut ctx: SpaceContext,
        offer: RequestId,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ProviderModelInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        ctx.budget = budget.context(ctx.budget.request.clone());
        // Revalidate caller authentication, Space admission, and membership
        // BEFORE querying `provider_attachments` so unauthorized or revoked
        // callers cannot probe attachment IDs via ResourceNotFound vs AccessDenied.
        let mut pre_tx = self.control.store.read(budget.clone()).await?;
        let pre_checked =
            budget
                .run(
                    async {
                        let (_, grant, _, _, _) =
                            self.offer_caller_access(pre_tx.inner_mut(), &ctx).await?;
                        let row = rows!(
                            pre_tx.inner_mut(),
                            ProviderAttachmentsRow,
                            fetch_optional,
                            "SELECT * FROM provider_attachments WHERE id=$1",
                            "SELECT * FROM v1_control.provider_attachments WHERE id=$1";
                            offer.as_str()
                        )?
                        .ok_or(DomainError::ResourceNotFound)?;
                        if row.target_space != ctx.scope().space_id.as_str() {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let project = match attachment_target(&row)? {
                            ProviderAttachmentTarget::Space(_) => None,
                            ProviderAttachmentTarget::Project(project) => Some(project),
                            ProviderAttachmentTarget::Personal { .. } => {
                                return Err(DomainError::ResourceNotFound.into());
                            }
                        };
                        if grant.project_root.as_ref().is_some_and(|root| {
                            project.as_ref().map(|p| &p.folder_id) != Some(root)
                        }) {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        if self
                            .offered_review_without_kind(pre_tx.inner_mut(), &row)
                            .await?
                            .is_none()
                        {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        Ok::<_, PortError>((row, project))
                    },
                    CommitEffect::NotCommitted,
                )
                .await;
        budget
            .run(pre_tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let (observed, project) = pre_checked?;
        let catalog = self.offer_catalog(&ctx, &project).await?;
        let mut tx = self.control.store.read(budget.clone()).await?;
        let result = budget.run(async {
            let scope_access = self
                .offer_access(
                    tx.inner_mut(),
                    &ctx,
                    project.as_ref(),
                    ("offer-models", &project, &offer),
                )
                .await?;
            let row = rows!(tx.inner_mut(), ProviderAttachmentsRow, fetch_optional,
                "SELECT * FROM provider_attachments WHERE id=$1",
                "SELECT * FROM v1_control.provider_attachments WHERE id=$1"; offer.as_str())?
                .ok_or(DomainError::ResourceNotFound)?;
            if attachment_target(&row)? != attachment_target(&observed)? || row.resource_id != observed.resource_id {
                return Err(DomainError::ResourceNotFound.into());
            }
            let review = self.offered_review(tx.inner_mut(), &row, catalog.space.kind).await?
                .ok_or(DomainError::ResourceNotFound)?;
            let version = serde_json::to_vec(&(
                scope_access, row.revision, review.resource.revision,
                review.resource.consent_epoch, review.current_credential_consent_epoch,
            )).map_err(|_| invalid(ValidationReason::InvalidState))?;
            let access = ContentDigest::from_bytes(*blake3::hash(&version).as_bytes());
            let last = position(&page, &access)?;
            let rows = page_rows!(tx.inner_mut(), ProviderModelsRow, TargetTable::ProviderModels, page.limit(),
                "SELECT * FROM provider_models WHERE resource_id=$1 AND model_id>$2 ORDER BY model_id LIMIT $3",
                "SELECT * FROM v1_control.provider_models WHERE resource_id=$1 AND model_id>$2 ORDER BY model_id LIMIT $3";
                &row.resource_id, &last, i64::from(page.limit())+1)?;
            let last = rows.rows.last().map(|row| row.model_id.clone());
            let items = rows.rows.iter().map(model_info).collect::<Result<_, _>>()?;
            Ok(ControlPage { items, continuation: continuation(access, rows.has_more, last)? })
        }, CommitEffect::NotCommitted).await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(result)
    }
}
