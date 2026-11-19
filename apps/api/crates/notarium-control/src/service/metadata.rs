//! Current, bounded canonical metadata. References never grant content access.
use super::ControlService;
use crate::{error::invalid, store::lease::OperationBudget};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceLifecycle},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::{FolderRef, Lifecycle, NoteRef},
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};

pub(super) fn hidden(error: &PortError) -> bool {
    matches!(
        error,
        PortError::Domain(DomainError::ResourceNotFound | DomainError::AccessDenied)
    )
}
pub(super) fn digest(
    auth: &EngineAuthContext,
    extra: impl Serialize,
) -> Result<ContentDigest, PortError> {
    let grants: Vec<_> = auth
        .spaces()
        .iter()
        .map(|(space, grant)| {
            (
                space,
                grant.role,
                &grant.read_classes,
                &grant.write_classes,
                &grant.project_root,
            )
        })
        .collect();
    let bytes = serde_json::to_vec(&(1, auth.principal(), auth.grant(), grants, extra))
        .map_err(|_| invalid(ValidationReason::InvalidState))?;
    Ok(ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes()))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectCursor {
    version: u8,
    scope: ContentDigest,
    space: SpaceId,
    inner: Option<String>,
}
impl ControlService {
    pub(super) async fn catalog_folder(
        &self,
        ctx: &AccountContext,
        folder: &FolderRef,
    ) -> Result<CatalogFolder, PortError> {
        if !ctx.auth().spaces().contains_key(&folder.space_id) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let value = self.catalog.folder(ctx.clone(), folder.clone()).await?;
        if value.reference != *folder
            || value.space.id != folder.space_id
            || value.ancestor_folders.len() > 4096
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if value.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        ctx.auth()
            .can_view_folder(&value.space, &folder.folder_id, &value.ancestor_folders)?;
        Ok(value)
    }
    pub async fn resolve_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> Result<ResolvedMemoryTarget, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (current, space) = self
            .memory_authority(&ctx, &budget, &target, &category)
            .await?;
        budget
            .run(
                async {
                    let value = self
                        .catalog
                        .resolve_or_ensure_memory_target(
                            current.clone(),
                            target.clone(),
                            category.clone(),
                        )
                        .await?;
                    if value.target != target
                        || value.category != category
                        || value.note.space_id != space.space.id
                    {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    let note = self.catalog_note(&current, &value.note).await?;
                    if note.facts.class != notarium_core::classes::DocClass::AgentMemory {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    current
                        .auth()
                        .authorize_direct_write(&note.facts, &note.facts)?;
                    if let MemoryTarget::Project { folder } = &target
                        && !note.facts.ancestor_folders.contains(&folder.folder_id)
                    {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    Ok(value)
                },
                // The canonical owner may create the missing slot before response loss.
                CommitEffect::Unknown,
            )
            .await
    }

    pub async fn inspect_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> Result<MemoryTargetSnapshot, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (current, space) = self
            .memory_authority(&ctx, &budget, &target, &category)
            .await?;
        let value = budget
            .run(
                self.catalog
                    .inspect_memory_target(current, target.clone(), category.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        space.history.check(&value.scope)?;
        if value.resolved.target != target
            || value.resolved.category != category
            || value.resolved.note.space_id != space.space.id
            || matches!(&target, MemoryTarget::Project { folder } if folder.folder_id != value.parent)
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        Ok(value)
    }

    async fn memory_authority(
        &self,
        ctx: &AccountContext,
        budget: &OperationBudget,
        target: &MemoryTarget,
        category: &str,
    ) -> Result<(AccountContext, CatalogSpace), PortError> {
        if category.is_empty()
            || category.len() > 64
            || !category.as_bytes()[0].is_ascii_lowercase()
            || !category
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        let (mut rtx, auth) = self
            .open_revalidated_read(budget, &ctx.budget.request, ctx.auth())
            .await?;
        let personal = budget
            .run(
                async {
                    let MemoryTarget::User { owner } = target else {
                        return Ok(None);
                    };
                    if owner != auth.principal() {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let user = super::authority::user_read(rtx.inner_mut(), owner.as_str()).await?;
                    Ok(Some(SpaceId::parse(
                        user.personal_space_id
                            .as_deref()
                            .ok_or(DomainError::ResourceNotFound)?,
                    )?))
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(rtx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let personal = personal?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let space = match target {
            MemoryTarget::User { .. } => personal.ok_or(DomainError::ResourceNotFound)?,
            MemoryTarget::Project { folder } => {
                budget
                    .run(
                        self.catalog_project(&current, folder),
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                folder.space_id.clone()
            }
        };
        let grant = current
            .auth()
            .spaces()
            .get(&space)
            .ok_or(DomainError::ResourceNotFound)?;
        if (matches!(target, MemoryTarget::User { .. }) && grant.project_root.is_some())
            || grant.role == notarium_core::auth::SpaceRole::Viewer
            || !grant
                .write_classes
                .contains(&notarium_core::classes::DocClass::AgentMemory)
            || current.auth().taint().is_tainted()
        {
            return Err(DomainError::SpaceReadOnly.into());
        }
        let catalog = budget
            .run(
                self.catalog_space(&current, &space),
                CommitEffect::NotCommitted,
            )
            .await?;
        Ok((current, catalog))
    }

    pub(super) async fn current_account(
        &self,
        ctx: &AccountContext,
        budget: &OperationBudget,
    ) -> Result<AccountContext, PortError> {
        let (rtx, auth) = self
            .open_revalidated_read(budget, &ctx.budget.request, ctx.auth())
            .await?;
        budget
            .run(rtx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(AccountContext::new(
            auth,
            budget.context(ctx.budget.request.clone()),
        ))
    }
    pub(super) async fn catalog_space(
        &self,
        ctx: &AccountContext,
        space: &SpaceId,
    ) -> Result<CatalogSpace, PortError> {
        if !ctx.auth().spaces().contains_key(space) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let value = self
            .catalog
            .space(ctx.budget.clone(), space.clone())
            .await?;
        if value.space.id != *space || value.history.space_id != *space {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if value.space.lifecycle != SpaceLifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(value)
    }
    pub(super) async fn catalog_project(
        &self,
        ctx: &AccountContext,
        project: &FolderRef,
    ) -> Result<ProjectInfo, PortError> {
        let grant = ctx
            .auth()
            .spaces()
            .get(&project.space_id)
            .ok_or(DomainError::ResourceNotFound)?;
        if grant.read_classes.is_empty()
            || grant
                .project_root
                .as_ref()
                .is_some_and(|root| root != &project.folder_id)
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let space = self.catalog_space(ctx, &project.space_id).await?;
        let scoped = SpaceContext::new(ctx.auth().clone(), space.history, ctx.budget.clone())?;
        let value = self.catalog.project(scoped, project.clone()).await?;
        if value.folder != *project || value.name.len() > 4096 {
            return Err(invalid(ValidationReason::InvalidState));
        }
        Ok(value)
    }
    pub(super) async fn catalog_note(
        &self,
        ctx: &AccountContext,
        note: &NoteRef,
    ) -> Result<CatalogNote, PortError> {
        if !ctx.auth().spaces().contains_key(&note.space_id) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let value = self.catalog.note(ctx.clone(), note.clone()).await?;
        if value.reference != *note || value.facts.space.id != note.space_id {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if value.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        ctx.auth().can_view_resource(&value.facts)?;
        Ok(value)
    }
    pub async fn list_projects(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ProjectInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let current = self.current_account(&ctx, &budget).await?;
        let scope = digest(current.auth(), "projects")?;
        let cursor: Option<ProjectCursor> = page
            .continuation()
            .map(|value| {
                serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidQuery))
            })
            .transpose()?;
        if cursor.as_ref().is_some_and(|cursor| {
            cursor.version != 1
                || cursor.scope != scope
                || !current.auth().spaces().contains_key(&cursor.space)
        }) {
            return Err(invalid(ValidationReason::CursorStale));
        }
        // One bounded canonical page per call. Empty filtered pages retain progress.
        let start = cursor.as_ref().map(|cursor| &cursor.space);
        let Some(space) = current
            .auth()
            .spaces()
            .keys()
            .find(|space| start.is_none_or(|start| *space >= start))
            .cloned()
        else {
            return Ok(ControlPage {
                items: vec![],
                continuation: None,
            });
        };
        let inner = cursor
            .as_ref()
            .and_then(|cursor| cursor.inner.as_ref())
            .map(|value| {
                let bytes = URL_SAFE_NO_PAD
                    .decode(value)
                    .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
                if bytes.len() > 2048 {
                    return Err(invalid(ValidationReason::InvalidLimit));
                }
                String::from_utf8(bytes).map_err(|_| invalid(ValidationReason::InvalidQuery))
            })
            .transpose()?;
        let catalog = budget
            .run(
                self.catalog_space(&current, &space),
                CommitEffect::NotCommitted,
            )
            .await?;
        let result = budget
            .run(
                self.catalog.projects(
                    SpaceContext::new(
                        current.auth().clone(),
                        catalog.history,
                        budget.context(ctx.budget.request.clone()),
                    )?,
                    ControlPageRequest::new(page.limit(), inner.clone())?,
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        if result.items.len() > usize::from(page.limit())
            || result.continuation.as_ref().is_some_and(|next| {
                next.is_empty() || next.len() > 2048 || Some(next) == inner.as_ref()
            })
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let mut items = Vec::with_capacity(result.items.len());
        for project in result.items {
            if project.folder.space_id != space || project.name.len() > 4096 {
                return Err(invalid(ValidationReason::InvalidState));
            }
            match current.auth().can_view_folder(
                &catalog.space,
                &project.folder.folder_id,
                std::slice::from_ref(&project.folder.folder_id),
            ) {
                Ok(()) => items.push(project),
                Err(DomainError::ResourceNotFound | DomainError::AccessDenied) => (),
                Err(error) => return Err(error.into()),
            }
        }
        let next = if let Some(inner) = result.continuation {
            Some(ProjectCursor {
                version: 1,
                scope,
                space,
                inner: Some(URL_SAFE_NO_PAD.encode(inner)),
            })
        } else {
            current
                .auth()
                .spaces()
                .keys()
                .find(|next| *next > &space)
                .map(|space| ProjectCursor {
                    version: 1,
                    scope,
                    space: space.clone(),
                    inner: None,
                })
        };
        let continuation = next
            .map(|next| {
                serde_json::to_string(&next).map_err(|_| invalid(ValidationReason::InvalidState))
            })
            .transpose()?;
        ControlPageRequest::new(page.limit(), continuation.clone())?;
        Ok(ControlPage {
            items,
            continuation,
        })
    }
}
