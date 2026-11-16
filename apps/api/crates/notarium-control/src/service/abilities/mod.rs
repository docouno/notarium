//! Effective ability metadata; immutable package content remains canonical-owned.
mod mutations;
use super::{
    ControlService,
    authority::*,
    metadata::{digest, hidden},
};
use crate::{
    error::invalid,
    store::{Transaction, lease::OperationBudget, statements::rows, target::*},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{
    DomainError,
    auth::{Cap, SpaceKind},
    classes::{AbilityKind, DocClass},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::{FolderRef, Lifecycle},
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};

pub(super) fn placement(value: &AbilityPlacement) -> Result<String, PortError> {
    serde_json::to_string(value).map_err(|_| invalid(ValidationReason::InvalidState))
}
fn valid_name(value: &str) -> Result<(), PortError> {
    if value.is_empty() || value.chars().count() > 128 || value.contains('\0') {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}
use crate::store::target::AbilityTrailPayload as Trail;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: ContentDigest,
    inner: String,
}
impl ControlService {
    async fn ability_placement(
        &self,
        ctx: &AccountContext,
        value: &AbilityPlacement,
    ) -> Result<(), PortError> {
        match value {
            AbilityPlacement::OwnedPersonal(owner) if owner != ctx.auth().principal() => {
                Err(DomainError::ResourceNotFound.into())
            }
            AbilityPlacement::OwnedSpace(space) => self.catalog_space(ctx, space).await.map(|_| ()),
            AbilityPlacement::OwnedProject(project) => {
                self.catalog_project(ctx, project).await.map(|_| ())
            }
            _ => Ok(()),
        }
    }
    pub(super) async fn raw_ability(
        &self,
        ctx: &AccountContext,
        identity: AbilityIdentity,
    ) -> Result<AbilityDescriptor, PortError> {
        self.ability_placement(ctx, &identity.placement).await?;
        let value = self
            .catalog
            .current_ability(ctx.clone(), identity.clone())
            .await?;
        if value.reference.identity() != identity
            || valid_name(&value.name).is_err()
            || value.auxiliary_files.len() > 64
            || value
                .auxiliary_files
                .iter()
                .any(|name| name.is_empty() || name.len() > 1024 || name.contains('\0'))
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if value.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        if identity.placement != AbilityPlacement::System {
            let note = self.catalog_note(ctx, &value.entrypoint).await?;
            if note.facts.class != DocClass::Skill
                || note.facts.ability_package.as_ref() != Some(&identity.id)
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            match identity.placement {
                AbilityPlacement::OwnedSpace(space) if space != value.entrypoint.space_id => {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                AbilityPlacement::OwnedProject(project)
                    if project.space_id != value.entrypoint.space_id
                        || !note.facts.ancestor_folders.contains(&project.folder_id) =>
                {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                AbilityPlacement::OwnedPersonal(_)
                    if note.facts.space.kind != SpaceKind::Personal =>
                {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                _ => (),
            }
        }
        Ok(value)
    }
    async fn overlay(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        mut value: AbilityDescriptor,
        project: Option<&FolderRef>,
    ) -> Result<AbilityDescriptor, PortError> {
        let key = placement(&value.reference.placement)?;
        let id = value.reference.id.as_str();
        let availability = rows!(tx,AbilityAvailabilityRow,fetch_optional,"SELECT * FROM ability_availability WHERE placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_availability WHERE placement=$1 AND ability_id=$2";&key,id)?;
        if let Some(row) = availability {
            value.enabled &= row.enabled == 1;
            if row.mode == "selected-projects" {
                let selected = if let Some(project) = project {
                    rows!(tx,AbilityProjectBindingsRow,fetch_optional,"SELECT * FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4","SELECT * FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4";&key,id,project.space_id.as_str(),project.folder_id.as_str())?.is_some()
                } else {
                    false
                };
                value.enabled &= selected;
            } else if row.mode != "all-projects" {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        let preference = rows!(tx,AbilityPreferencesRow,fetch_optional,"SELECT * FROM ability_preferences WHERE owner_id=$1 AND placement=$2 AND ability_id=$3","SELECT * FROM v1_control.ability_preferences WHERE owner_id=$1 AND placement=$2 AND ability_id=$3";ctx.auth().principal().as_str(),&key,id)?;
        if let Some(row) = preference {
            value.enabled &= row.enabled == 1;
        }
        Ok(value)
    }
    async fn follow_ability(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        mut reference: AbilityRef,
    ) -> Result<AbilityRef, PortError> {
        let mut visited = Vec::with_capacity(17);
        for hop in 0..=16 {
            self.ability_placement(ctx, &reference.placement).await?;
            let key = placement(&reference.placement)?;
            let identity = (key.clone(), reference.id.clone());
            if visited.contains(&identity) {
                return Err(invalid(ValidationReason::InvalidState));
            }
            visited.push(identity);
            let row = rows!(tx,AbilityPlacementTrailRow,fetch_optional,"SELECT * FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,reference.id.as_str())?;
            let Some(row) = row else {
                return Ok(reference);
            };
            let trail: Trail = serde_json::from_str(&row.manifest_ref)
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
            if trail.source != reference {
                return Ok(reference);
            }
            if hop == 16 {
                return Err(invalid(ValidationReason::InvalidState));
            }
            if placement(&trail.destination.placement)? != row.destination_placement
                || trail.destination.id.as_str() != row.destination_id
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            reference = trail.destination;
        }
        Err(invalid(ValidationReason::InvalidState))
    }
    pub(super) async fn resolve_ability_in(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        request: AbilitySelection,
    ) -> Result<AbilityResolution, PortError> {
        let (value, kind) = match request {
            AbilitySelection::Exact { reference, project } => {
                if let Some(project) = &project {
                    match self.catalog_project(ctx, project).await {
                        Ok(_) => (),
                        Err(error) if hidden(&error) => return Ok(AbilityResolution::OutOfScope),
                        Err(error) => return Err(error),
                    }
                }
                let reference = match self.follow_ability(tx, ctx, reference).await {
                    Ok(value) => value,
                    Err(error) if hidden(&error) => return Ok(AbilityResolution::OutOfScope),
                    Err(error) => return Err(error),
                };
                match (&reference.placement, project.as_ref()) {
                    (AbilityPlacement::OwnedProject(placement), Some(active))
                        if placement != active =>
                    {
                        return Ok(AbilityResolution::OutOfScope);
                    }
                    (AbilityPlacement::OwnedSpace(space), Some(active))
                        if *space != active.space_id =>
                    {
                        return Ok(AbilityResolution::OutOfScope);
                    }
                    _ => (),
                }
                let value = match self.raw_ability(ctx, reference.identity()).await {
                    Ok(value) => value,
                    Err(error) if hidden(&error) => return Ok(AbilityResolution::Missing),
                    Err(error) => return Err(error),
                };
                if value.reference != reference {
                    return Ok(AbilityResolution::Stale);
                }
                let effective_project = match &reference.placement {
                    AbilityPlacement::OwnedProject(placement) => Some(placement),
                    _ => project.as_ref(),
                };
                (self.overlay(tx, ctx, value, effective_project).await?, None)
            }
            AbilitySelection::Name {
                kind,
                name,
                project,
            } => {
                valid_name(&name)?;
                if let Some(project) = &project {
                    self.catalog_project(ctx, project).await?;
                }
                // A name lookup is bounded independently of inventory size. A
                // larger collision set fails instead of selecting a partial winner.
                let page = self
                    .catalog
                    .abilities(
                        ctx.clone(),
                        AbilityQuery {
                            page: ControlPageRequest::new(200, None)?,
                            project: project.clone(),
                            kind: None,
                            name: Some(name.clone()),
                            authoring: false,
                        },
                    )
                    .await?;
                if page.items.len() > 200 || page.continuation.is_some() {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                let mut winner: Option<AbilityDescriptor> = None;
                let mut ambiguous = false;
                for candidate in page.items {
                    if candidate.name != name {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    if let AbilityPlacement::OwnedProject(placement) =
                        &candidate.reference.placement
                        && Some(placement) != project.as_ref()
                    {
                        continue;
                    }
                    if let AbilityPlacement::OwnedSpace(space) = &candidate.reference.placement
                        && project
                            .as_ref()
                            .is_some_and(|project| &project.space_id != space)
                    {
                        continue;
                    }
                    let current = match self.raw_ability(ctx, candidate.reference.identity()).await
                    {
                        Ok(value) => value,
                        Err(error) if hidden(&error) => continue,
                        Err(error) => return Err(error),
                    };
                    if current.reference != candidate.reference {
                        continue;
                    }
                    if current.name != name {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    let candidate = self.overlay(tx, ctx, current, project.as_ref()).await?;
                    if let Some(previous) = &winner {
                        let level = candidate
                            .reference
                            .placement
                            .precedence()
                            .cmp(&previous.reference.placement.precedence());
                        if level.is_gt() {
                            continue;
                        }
                        if level.is_eq() {
                            if candidate.reference.identity() != previous.reference.identity() {
                                ambiguous = true;
                            }
                            continue;
                        }
                    }
                    winner = Some(candidate);
                    ambiguous = false;
                }
                if ambiguous {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                let Some(winner) = winner else {
                    return Ok(AbilityResolution::Missing);
                };
                (winner, Some(kind))
            }
        };
        Ok(if kind.is_some_and(|kind| kind != value.kind) {
            AbilityResolution::WrongKind
        } else if !value.enabled {
            AbilityResolution::Disabled
        } else if !value.healthy {
            AbilityResolution::Unhealthy
        } else {
            AbilityResolution::Resolved(Box::new(value))
        })
    }
    pub(super) async fn current_role_in_project(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        role: &AbilityRef,
        project: Option<&FolderRef>,
    ) -> Result<bool, PortError> {
        let checked = async {
            if self.follow_ability(tx, ctx, role.clone()).await? != *role {
                return Ok(false);
            }
            let raw = self.raw_ability(ctx, role.identity()).await?;
            if raw.reference != *role || raw.kind != AbilityKind::Role || !raw.healthy {
                return Ok(false);
            }
            Ok(self.overlay(tx, ctx, raw, project).await?.enabled)
        }
        .await;
        match checked {
            Err(error) if hidden(&error) => Ok(false),
            other => other,
        }
    }
    pub(super) async fn current_role_db_only(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        raw: AbilityDescriptor,
        project: Option<&FolderRef>,
    ) -> Result<bool, PortError> {
        if self
            .follow_ability_db(tx, ctx, raw.reference.clone())
            .await?
            != raw.reference
        {
            return Ok(false);
        }
        if raw.kind != AbilityKind::Role || !raw.healthy {
            return Ok(false);
        }
        Ok(self.overlay(tx, ctx, raw, project).await?.enabled)
    }
    pub(super) async fn follow_ability_db(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        mut reference: AbilityRef,
    ) -> Result<AbilityRef, PortError> {
        let mut visited = Vec::with_capacity(17);
        for hop in 0..=16 {
            match &reference.placement {
                AbilityPlacement::OwnedPersonal(owner) if owner != ctx.auth().principal() => {
                    return Err(DomainError::ResourceNotFound.into());
                }
                AbilityPlacement::OwnedSpace(space) if !ctx.auth().spaces().contains_key(space) => {
                    return Err(DomainError::ResourceNotFound.into());
                }
                AbilityPlacement::OwnedProject(project)
                    if !ctx.auth().spaces().contains_key(&project.space_id) =>
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                _ => (),
            }
            let key = placement(&reference.placement)?;
            let identity = (key.clone(), reference.id.clone());
            if visited.contains(&identity) {
                return Err(invalid(ValidationReason::InvalidState));
            }
            visited.push(identity);
            let row = rows!(tx,AbilityPlacementTrailRow,fetch_optional,"SELECT * FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,reference.id.as_str())?;
            let Some(row) = row else {
                return Ok(reference);
            };
            let trail: Trail = serde_json::from_str(&row.manifest_ref)
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
            if trail.source != reference {
                return Ok(reference);
            }
            if hop == 16 {
                return Err(invalid(ValidationReason::InvalidState));
            }
            if placement(&trail.destination.placement)? != row.destination_placement
                || trail.destination.id.as_str() != row.destination_id
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            reference = trail.destination;
        }
        Err(invalid(ValidationReason::InvalidState))
    }
    pub async fn resolve_ability(
        &self,
        ctx: AccountContext,
        request: AbilitySelection,
    ) -> Result<AbilityResolution, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.read(budget.clone()).await?;
        let value = budget
            .run(
                async {
                    let auth = self.revalidate_read(tx.inner_mut(), ctx.auth()).await?;
                    self.resolve_ability_in(
                        tx.inner_mut(),
                        &AccountContext::new(auth, budget.context(ctx.budget.request.clone())),
                        request,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(value)
    }
    pub async fn get_ability(
        &self,
        ctx: AccountContext,
        reference: AbilityRef,
        project: Option<FolderRef>,
    ) -> Result<AbilityDescriptor, PortError> {
        match self
            .resolve_ability(ctx, AbilitySelection::Exact { reference, project })
            .await?
        {
            AbilityResolution::Resolved(value) => Ok(*value),
            _ => Err(DomainError::ResourceNotFound.into()),
        }
    }
    async fn ability_scope(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        query: &AbilityQuery,
    ) -> Result<ContentDigest, PortError> {
        let owner = user_read(tx, ctx.auth().principal().as_str()).await?;
        let mut revisions = Vec::with_capacity(ctx.auth().spaces().len());
        for space in ctx.auth().spaces().keys() {
            revisions.push((
                space,
                super::spaces::admission(tx, space, false).await?.revision,
            ));
        }
        digest(
            ctx.auth(),
            (
                "abilities",
                owner.metadata_revision,
                revisions,
                &query.project,
                query.kind,
                &query.name,
                query.authoring,
            ),
        )
    }
    pub async fn discover_abilities(
        &self,
        ctx: AccountContext,
        query: AbilityQuery,
    ) -> Result<ControlPage<AbilityDescriptor>, PortError> {
        if let Some(name) = &query.name {
            valid_name(name)?;
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.read(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let auth = self.revalidate_read(tx.inner_mut(), ctx.auth()).await?;
                    if query.authoring && !auth.has_cap(Cap::AbilityWrite) {
                        return Err(DomainError::AbilityWriteForbidden.into());
                    }
                    let current =
                        AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
                    if let Some(project) = &query.project {
                        self.catalog_project(&current, project).await?;
                    }
                    let scope = self.ability_scope(tx.inner_mut(), &current, &query).await?;
                    let inner = query
                        .page
                        .continuation()
                        .map(|value| {
                            let cursor: Cursor = serde_json::from_str(value)
                                .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
                            if cursor.version != 1 || cursor.scope != scope {
                                return Err(invalid(ValidationReason::CursorStale));
                            }
                            let bytes = URL_SAFE_NO_PAD
                                .decode(cursor.inner)
                                .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
                            if bytes.is_empty() || bytes.len() > 2048 {
                                return Err(invalid(ValidationReason::InvalidLimit));
                            }
                            String::from_utf8(bytes)
                                .map_err(|_| invalid(ValidationReason::InvalidQuery))
                        })
                        .transpose()?;
                    let raw = self
                        .catalog
                        .abilities(
                            current.clone(),
                            AbilityQuery {
                                page: ControlPageRequest::new(query.page.limit(), inner.clone())?,
                                ..query.clone()
                            },
                        )
                        .await?;
                    if raw.items.len() > usize::from(query.page.limit())
                        || raw.continuation.as_ref().is_some_and(|value| {
                            value.is_empty() || value.len() > 2048 || Some(value) == inner.as_ref()
                        })
                    {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    let mut items = Vec::new();
                    let mut winners: std::collections::BTreeMap<
                        (bool, String),
                        Option<AbilityDescriptor>,
                    > = std::collections::BTreeMap::new();
                    for candidate in raw.items {
                        if query.kind.is_some_and(|kind| kind != candidate.kind)
                            || query
                                .name
                                .as_ref()
                                .is_some_and(|name| name != &candidate.name)
                        {
                            return Err(invalid(ValidationReason::InvalidState));
                        }
                        if let AbilityPlacement::OwnedProject(project) =
                            &candidate.reference.placement
                            && Some(project) != query.project.as_ref()
                        {
                            continue;
                        }
                        if let AbilityPlacement::OwnedSpace(space) = &candidate.reference.placement
                            && query
                                .project
                                .as_ref()
                                .is_some_and(|project| &project.space_id != space)
                        {
                            continue;
                        }
                        let value = match self
                            .raw_ability(&current, candidate.reference.identity())
                            .await
                        {
                            Ok(value) => value,
                            Err(error) if hidden(&error) => continue,
                            Err(error) => return Err(error),
                        };
                        if value.reference != candidate.reference {
                            continue;
                        }
                        if query.authoring {
                            items.push(
                                self.overlay(
                                    tx.inner_mut(),
                                    &current,
                                    value,
                                    query.project.as_ref(),
                                )
                                .await?,
                            );
                        } else {
                            let winner_key =
                                (matches!(value.kind, AbilityKind::Role), value.name.clone());
                            let cached = if let Some(existing) = winners.get(&winner_key) {
                                existing.clone()
                            } else {
                                let resolved = match self
                                    .resolve_ability_in(
                                        tx.inner_mut(),
                                        &current,
                                        AbilitySelection::Name {
                                            name: value.name.clone(),
                                            kind: value.kind,
                                            project: query.project.clone(),
                                        },
                                    )
                                    .await?
                                {
                                    AbilityResolution::Resolved(w) => Some(*w),
                                    _ => None,
                                };
                                winners.insert(winner_key, resolved.clone());
                                resolved
                            };
                            if let Some(winner) = cached
                                && winner.reference == value.reference
                            {
                                items.push(winner);
                            }
                        }
                    }
                    let continuation = raw
                        .continuation
                        .map(|inner| {
                            serde_json::to_string(&Cursor {
                                version: 1,
                                scope,
                                inner: URL_SAFE_NO_PAD.encode(inner),
                            })
                            .map_err(|_| invalid(ValidationReason::InvalidState))
                        })
                        .transpose()?;
                    ControlPageRequest::new(query.page.limit(), continuation.clone())?;
                    Ok(ControlPage {
                        items,
                        continuation,
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
