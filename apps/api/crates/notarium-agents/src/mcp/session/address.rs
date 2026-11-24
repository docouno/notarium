use super::super::{ToolCallContext, invalid};
use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    error::{PortError, ValidationReason},
    ids::SpaceId,
    model::FolderRef,
    ports::{
        AccessibleSpace, CatalogSpace, ControlPageRequest, ProjectInfo, ProviderErrorCode,
        SpaceContext,
    },
};
use notarium_syntax::unicode::lookup_key;
use std::collections::BTreeMap;

const MAX_SPACES: usize = 4096;
const CONTROL_PAGE: u16 = 128;
const MAX_PROJECTS: usize = 4096;

pub(in super::super) async fn readable_spaces(
    call: &ToolCallContext<'_>,
) -> Result<BTreeMap<SpaceId, AccessibleSpace>, PortError> {
    let mut spaces = BTreeMap::new();
    let mut next = None;
    let account = call.account();
    for _ in 0..=MAX_SPACES {
        let page = call
            .registry
            .control
            .list_spaces(
                call.account(),
                ControlPageRequest::new(CONTROL_PAGE, next.clone())?,
            )
            .await?;
        if page.items.len() > usize::from(CONTROL_PAGE) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        for item in page.items {
            let id = &item.space.id;
            if item.history.space_id != *id || item.space.lifecycle != SpaceLifecycle::Active {
                return Err(invalid(ValidationReason::InvalidState));
            }
            if account
                .auth()
                .spaces()
                .get(id)
                .is_none_or(|grant| grant.read_classes.is_empty())
            {
                continue;
            }
            if spaces.insert(id.clone(), item).is_some() {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        if spaces.len() > MAX_SPACES {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let Some(cursor) = page.continuation else {
            return Ok(spaces);
        };
        if next.as_ref() == Some(&cursor) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        next = Some(cursor);
    }
    Err(invalid(ValidationReason::BudgetExceeded))
}

pub(super) async fn visible_projects(
    call: &ToolCallContext<'_>,
) -> Result<Vec<ProjectInfo>, PortError> {
    let mut projects = Vec::new();
    let mut next = None;
    for _ in 0..=MAX_SPACES + MAX_PROJECTS {
        let page = call
            .registry
            .control
            .list_projects(
                call.account(),
                ControlPageRequest::new(CONTROL_PAGE, next.clone())?,
            )
            .await?;
        if page.items.len() > usize::from(CONTROL_PAGE) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        projects.extend(page.items);
        if projects.len() > MAX_PROJECTS {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let Some(cursor) = page.continuation else {
            return Ok(projects);
        };
        if next.as_ref() == Some(&cursor) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        next = Some(cursor);
    }
    Err(invalid(ValidationReason::BudgetExceeded))
}

pub(in super::super) async fn space(
    call: &ToolCallContext<'_>,
    id: &SpaceId,
) -> Result<SpaceContext, PortError> {
    call.space(readable_space(call, id).await?.history)
}

pub(in super::super) async fn readable_space(
    call: &ToolCallContext<'_>,
    id: &SpaceId,
) -> Result<CatalogSpace, PortError> {
    let account = call.account();
    if account
        .auth()
        .spaces()
        .get(id)
        .is_none_or(|grant| grant.read_classes.is_empty())
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let space = call
        .registry
        .catalog
        .space(call.budget(), id.clone())
        .await?;
    if space.space.id != *id || space.history.space_id != *id {
        return Err(invalid(ValidationReason::InvalidState));
    }
    if space.space.lifecycle != SpaceLifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(space)
}

async fn admit_in_app_address(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    project: Option<&FolderRef>,
) -> Result<(), PortError> {
    if !matches!(
        call.target,
        super::super::EgressTarget::InAppProvider { .. }
    ) {
        return Ok(());
    }
    let selection_project = match &call.target {
        super::super::EgressTarget::InAppProvider {
            primary_project, ..
        } if call.auth.pinned_write_space() == Some(&scope.scope().space_id) => {
            primary_project.clone()
        }
        _ => project.cloned(),
    };
    let selection = match call.provider_selection(scope, selection_project).await {
        Ok(Some(selection)) => selection,
        Ok(None) => return Ok(()),
        Err(PortError::Domain(DomainError::Provider {
            error: ProviderErrorCode::Unavailable,
        })) => return Err(DomainError::ResourceNotFound.into()),
        Err(error) if super::super::corpus::hidden(&error) => {
            return Err(DomainError::ResourceNotFound.into());
        }
        Err(error) => return Err(error),
    };
    if let Some(required) = &selection.project_only
        && project != Some(required)
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}

pub(in super::super) async fn resolve_space(
    call: &ToolCallContext<'_>,
    value: &str,
) -> Result<SpaceContext, PortError> {
    let scope = if let Ok(id) = SpaceId::parse(value)
        && call.account().auth().spaces().contains_key(&id)
    {
        space(call, &id).await?
    } else {
        space_by_slug(call, value).await?
    };
    admit_in_app_address(call, &scope, None).await?;
    Ok(scope)
}

async fn space_by_slug(call: &ToolCallContext<'_>, slug: &str) -> Result<SpaceContext, PortError> {
    let key = lookup_key(slug);
    let spaces = readable_spaces(call).await?;
    let mut candidates = spaces.values().filter(|item| lookup_key(&item.slug) == key);
    let scope = candidates
        .next()
        .ok_or(DomainError::ResourceNotFound)?
        .history
        .clone();
    if candidates.next().is_some() {
        return Err(invalid(ValidationReason::InvalidState));
    }
    call.space(scope)
}

pub(in super::super) async fn resolve_project(
    call: &ToolCallContext<'_>,
    handle: &str,
) -> Result<ProjectInfo, PortError> {
    let (space, slug) = project_handle(handle)?;
    let scope = space_by_slug(call, space).await?;
    let project = call
        .registry
        .catalog
        .project_by_slug(scope.clone(), slug.to_owned())
        .await?;
    if project.folder.space_id != scope.scope().space_id {
        return Err(invalid(ValidationReason::InvalidState));
    }
    admit_in_app_address(call, &scope, Some(&project.folder)).await?;
    Ok(project)
}

pub(in super::super) async fn project_for_folder(
    call: &ToolCallContext<'_>,
    project: &FolderRef,
) -> Result<ProjectInfo, PortError> {
    let scope = space(call, &project.space_id).await?;
    let item = call
        .registry
        .catalog
        .project(scope, project.clone())
        .await?;
    if item.folder != *project {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(item)
}

fn project_handle(value: &str) -> Result<(&str, &str), PortError> {
    let (space, project) = value
        .split_once('/')
        .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?;
    if space.is_empty()
        || project.is_empty()
        || project.contains('/')
        || space.len() > 255
        || project.len() > 255
        || value.chars().any(char::is_control)
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok((space, project))
}
