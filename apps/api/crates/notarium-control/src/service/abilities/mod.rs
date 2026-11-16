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
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn placement(value: &AbilityPlacement) -> Result<String, PortError> {
    serde_json::to_string(value).map_err(|_| invalid(ValidationReason::InvalidState))
}
pub(super) fn role_placement_matches_project(
    placement: &AbilityPlacement,
    project: Option<&FolderRef>,
) -> bool {
    match placement {
        AbilityPlacement::OwnedProject(role_project) => project == Some(role_project),
        AbilityPlacement::OwnedSpace(role_space) => {
            project.is_none_or(|active| &active.space_id == role_space)
        }
        AbilityPlacement::OwnedPersonal(_) | AbilityPlacement::System => true,
    }
}
fn classify_resolution(
    winner: Option<AbilityDescriptor>,
    expected_kind: Option<AbilityKind>,
) -> AbilityResolution {
    let Some(value) = winner else {
        return AbilityResolution::Missing;
    };
    if expected_kind.is_some_and(|kind| kind != value.kind) {
        AbilityResolution::WrongKind
    } else if !value.enabled {
        AbilityResolution::Disabled
    } else if !value.healthy {
        AbilityResolution::Unhealthy
    } else {
        AbilityResolution::Resolved(Box::new(value))
    }
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
    pub(super) async fn ability_placement(
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
    async fn ability_placement_cached(
        &self,
        ctx: &AccountContext,
        value: &AbilityPlacement,
        checked_spaces: &mut BTreeSet<SpaceId>,
        checked_projects: &mut BTreeSet<(SpaceId, FolderId)>,
    ) -> Result<(), PortError> {
        match value {
            AbilityPlacement::OwnedPersonal(owner) if owner != ctx.auth().principal() => {
                Err(DomainError::ResourceNotFound.into())
            }
            AbilityPlacement::OwnedSpace(space) => {
                if !checked_spaces.contains(space) {
                    self.catalog_space(ctx, space).await?;
                    checked_spaces.insert(space.clone());
                }
                Ok(())
            }
            AbilityPlacement::OwnedProject(project) => {
                let key = (project.space_id.clone(), project.folder_id.clone());
                if !checked_projects.contains(&key) {
                    self.catalog_project(ctx, project).await?;
                    checked_projects.insert(key);
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    pub(super) async fn raw_ability(
        &self,
        ctx: &AccountContext,
        identity: AbilityIdentity,
    ) -> Result<AbilityDescriptor, PortError> {
        let mut spaces = BTreeSet::new();
        let mut projects = BTreeSet::new();
        self.raw_ability_uncached(ctx, identity, &mut spaces, &mut projects)
            .await
    }
    async fn raw_ability_uncached(
        &self,
        ctx: &AccountContext,
        identity: AbilityIdentity,
        checked_spaces: &mut BTreeSet<SpaceId>,
        checked_projects: &mut BTreeSet<(SpaceId, FolderId)>,
    ) -> Result<AbilityDescriptor, PortError> {
        self.ability_placement_cached(ctx, &identity.placement, checked_spaces, checked_projects)
            .await?;
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
    async fn raw_ability_cached(
        &self,
        ctx: &AccountContext,
        identity: AbilityIdentity,
        checked_spaces: &mut BTreeSet<SpaceId>,
        checked_projects: &mut BTreeSet<(SpaceId, FolderId)>,
        cache: &mut BTreeMap<(String, AbilityId), Option<AbilityDescriptor>>,
    ) -> Result<Option<AbilityDescriptor>, PortError> {
        let key = (placement(&identity.placement)?, identity.id.clone());
        if let Some(existing) = cache.get(&key) {
            return Ok(existing.clone());
        }
        let resolved = match self
            .raw_ability_uncached(ctx, identity, checked_spaces, checked_projects)
            .await
        {
            Ok(value) => Some(value),
            Err(error) if hidden(&error) => None,
            Err(error) => return Err(error),
        };
        cache.insert(key, resolved.clone());
        Ok(resolved)
    }
    pub(super) async fn overlay(
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
    async fn select_overlaid_winner(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        project: Option<&FolderRef>,
        candidates: Vec<AbilityDescriptor>,
    ) -> Result<Option<AbilityDescriptor>, PortError> {
        let mut winner: Option<AbilityDescriptor> = None;
        let mut ambiguous = false;
        for current in candidates {
            let candidate = self.overlay(tx, ctx, current, project).await?;
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
        Ok(winner)
    }
    pub(super) async fn check_active_role_catalog(
        &self,
        ctx: &AccountContext,
        role: &AbilityRef,
        followed: Result<(AbilityRef, Vec<AbilityPlacement>), PortError>,
        project: Option<&FolderRef>,
    ) -> Result<Option<AbilityDescriptor>, PortError> {
        if !role_placement_matches_project(&role.placement, project) {
            return Ok(None);
        }
        let (final_ref, visited) = match followed {
            Ok(pair) => pair,
            Err(error) if hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        if final_ref != *role {
            return Ok(None);
        }
        for item in &visited {
            match self.ability_placement(ctx, item).await {
                Ok(()) => (),
                Err(error) if hidden(&error) => return Ok(None),
                Err(error) => return Err(error),
            }
        }
        let raw = match self.raw_ability(ctx, role.identity()).await {
            Ok(raw) => raw,
            Err(error) if hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        if raw.reference != *role || raw.kind != AbilityKind::Role || !raw.healthy {
            return Ok(None);
        }
        Ok(Some(raw))
    }
    pub(super) async fn current_role_db_only(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        raw: AbilityDescriptor,
        project: Option<&FolderRef>,
    ) -> Result<bool, PortError> {
        if !role_placement_matches_project(&raw.reference.placement, project) {
            return Ok(false);
        }
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
        reference: AbilityRef,
    ) -> Result<AbilityRef, PortError> {
        self.follow_ability_chain_db(tx, ctx, reference)
            .await
            .map(|(final_ref, _)| final_ref)
    }
    pub(super) async fn follow_ability_chain_db(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        mut reference: AbilityRef,
    ) -> Result<(AbilityRef, Vec<AbilityPlacement>), PortError> {
        let mut visited = Vec::with_capacity(17);
        let mut placements = Vec::with_capacity(17);
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
            placements.push(reference.placement.clone());
            let row = rows!(tx,AbilityPlacementTrailRow,fetch_optional,"SELECT * FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,reference.id.as_str())?;
            let Some(row) = row else {
                return Ok((reference, placements));
            };
            let trail: Trail = serde_json::from_str(&row.manifest_ref)
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
            if trail.source != reference {
                return Ok((reference, placements));
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
        if let AbilitySelection::Name { name, .. } = &request {
            valid_name(name)?;
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        match request {
            AbilitySelection::Exact { reference, project } => {
                let followed = budget
                    .run(
                        self.follow_ability_chain_db(rtx.inner_mut(), &current, reference),
                        CommitEffect::NotCommitted,
                    )
                    .await;
                budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
                let (value, effective_project) = match budget
                    .run(
                        async {
                            if let Some(project) = &project {
                                match self.catalog_project(&current, project).await {
                                    Ok(_) => (),
                                    Err(error) if hidden(&error) => {
                                        return Ok(Err(AbilityResolution::OutOfScope));
                                    }
                                    Err(error) => return Err(error),
                                }
                            }
                            let (reference, visited) = match followed {
                                Ok(pair) => pair,
                                Err(error) if hidden(&error) => {
                                    return Ok(Err(AbilityResolution::OutOfScope));
                                }
                                Err(error) => return Err(error),
                            };
                            for item in &visited {
                                match self.ability_placement(&current, item).await {
                                    Ok(()) => (),
                                    Err(error) if hidden(&error) => {
                                        return Ok(Err(AbilityResolution::OutOfScope));
                                    }
                                    Err(error) => return Err(error),
                                }
                            }
                            match (&reference.placement, project.as_ref()) {
                                (AbilityPlacement::OwnedProject(placement), Some(active))
                                    if placement != active =>
                                {
                                    return Ok(Err(AbilityResolution::OutOfScope));
                                }
                                (AbilityPlacement::OwnedSpace(space), Some(active))
                                    if *space != active.space_id =>
                                {
                                    return Ok(Err(AbilityResolution::OutOfScope));
                                }
                                _ => (),
                            }
                            let value = match self.raw_ability(&current, reference.identity()).await
                            {
                                Ok(value) => value,
                                Err(error) if hidden(&error) => {
                                    return Ok(Err(AbilityResolution::Missing));
                                }
                                Err(error) => return Err(error),
                            };
                            if value.reference != reference {
                                return Ok(Err(AbilityResolution::Stale));
                            }
                            let effective = match &reference.placement {
                                AbilityPlacement::OwnedProject(placement) => {
                                    Some(placement.clone())
                                }
                                _ => project,
                            };
                            Ok(Ok((value, effective)))
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?
                {
                    Ok(pair) => pair,
                    Err(early) => return Ok(early),
                };
                let mut rtx = self.store.read(budget.clone()).await?;
                let overlaid = budget
                    .run(
                        self.overlay(rtx.inner_mut(), &current, value, effective_project.as_ref()),
                        CommitEffect::NotCommitted,
                    )
                    .await;
                budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
                Ok(classify_resolution(Some(overlaid?), None))
            }
            AbilitySelection::Name {
                kind,
                name,
                project,
            } => {
                budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
                let candidates = budget
                    .run(
                        async {
                            let mut checked_spaces = BTreeSet::new();
                            let mut checked_projects = BTreeSet::new();
                            let mut raw_cache = BTreeMap::new();
                            if let Some(project) = &project {
                                self.catalog_project(&current, project).await?;
                                checked_projects
                                    .insert((project.space_id.clone(), project.folder_id.clone()));
                                checked_spaces.insert(project.space_id.clone());
                            }
                            let page = self
                                .catalog
                                .abilities(
                                    current.clone(),
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
                            let mut verified = Vec::new();
                            for candidate in page.items {
                                if candidate.name != name {
                                    return Err(invalid(ValidationReason::InvalidState));
                                }
                                if !role_placement_matches_project(
                                    &candidate.reference.placement,
                                    project.as_ref(),
                                ) {
                                    continue;
                                }
                                let Some(actual) = self
                                    .raw_ability_cached(
                                        &current,
                                        candidate.reference.identity(),
                                        &mut checked_spaces,
                                        &mut checked_projects,
                                        &mut raw_cache,
                                    )
                                    .await?
                                else {
                                    continue;
                                };
                                if actual.reference != candidate.reference {
                                    continue;
                                }
                                if actual.name != name {
                                    return Err(invalid(ValidationReason::InvalidState));
                                }
                                verified.push(actual);
                            }
                            Ok(verified)
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                if candidates.is_empty() {
                    return Ok(AbilityResolution::Missing);
                }
                let mut rtx = self.store.read(budget.clone()).await?;
                let winner = budget
                    .run(
                        self.select_overlaid_winner(
                            rtx.inner_mut(),
                            &current,
                            project.as_ref(),
                            candidates,
                        ),
                        CommitEffect::NotCommitted,
                    )
                    .await;
                budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
                Ok(classify_resolution(winner?, Some(kind)))
            }
        }
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
        let (mut rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        if query.authoring && !auth.has_cap(Cap::AbilityWrite) {
            let _ = rtx.finish().await;
            return Err(DomainError::AbilityWriteForbidden.into());
        }
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let scope_result = budget
            .run(
                self.ability_scope(rtx.inner_mut(), &current, &query),
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let scope = scope_result?;
        let (page_candidates, by_name_candidates, continuation) = budget
            .run(
                async {
                    let mut checked_spaces = BTreeSet::new();
                    let mut checked_projects = BTreeSet::new();
                    let mut raw_cache = BTreeMap::new();
                    if let Some(project) = &query.project {
                        self.catalog_project(&current, project).await?;
                        checked_projects
                            .insert((project.space_id.clone(), project.folder_id.clone()));
                        checked_spaces.insert(project.space_id.clone());
                    }
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
                    let complete_unfiltered_page =
                        inner.is_none() && raw.continuation.is_none() && query.kind.is_none();
                    let mut page_candidates = Vec::with_capacity(raw.items.len());
                    for candidate in raw.items {
                        if query.kind.is_some_and(|kind| kind != candidate.kind)
                            || query
                                .name
                                .as_ref()
                                .is_some_and(|name| name != &candidate.name)
                        {
                            return Err(invalid(ValidationReason::InvalidState));
                        }
                        if !role_placement_matches_project(
                            &candidate.reference.placement,
                            query.project.as_ref(),
                        ) {
                            continue;
                        }
                        let Some(value) = self
                            .raw_ability_cached(
                                &current,
                                candidate.reference.identity(),
                                &mut checked_spaces,
                                &mut checked_projects,
                                &mut raw_cache,
                            )
                            .await?
                        else {
                            continue;
                        };
                        if value.reference != candidate.reference {
                            continue;
                        }
                        page_candidates.push(value);
                    }
                    let mut by_name_candidates: BTreeMap<String, Vec<AbilityDescriptor>> =
                        BTreeMap::new();
                    if !query.authoring && !page_candidates.is_empty() {
                        if complete_unfiltered_page {
                            for candidate in &page_candidates {
                                by_name_candidates
                                    .entry(candidate.name.clone())
                                    .or_default()
                                    .push(candidate.clone());
                            }
                        } else {
                            let page_names: BTreeSet<String> =
                                page_candidates.iter().map(|c| c.name.clone()).collect();
                            let mut bulk_complete = false;
                            if page_names.len() > 1 {
                                let all = self
                                    .catalog
                                    .abilities(
                                        current.clone(),
                                        AbilityQuery {
                                            page: ControlPageRequest::new(200, None)?,
                                            project: query.project.clone(),
                                            kind: None,
                                            name: query.name.clone(),
                                            authoring: false,
                                        },
                                    )
                                    .await?;
                                if all.items.len() <= 200 && all.continuation.is_none() {
                                    bulk_complete = true;
                                    for candidate in all.items {
                                        if !page_names.contains(&candidate.name) {
                                            continue;
                                        }
                                        if !role_placement_matches_project(
                                            &candidate.reference.placement,
                                            query.project.as_ref(),
                                        ) {
                                            continue;
                                        }
                                        let Some(actual) = self
                                            .raw_ability_cached(
                                                &current,
                                                candidate.reference.identity(),
                                                &mut checked_spaces,
                                                &mut checked_projects,
                                                &mut raw_cache,
                                            )
                                            .await?
                                        else {
                                            continue;
                                        };
                                        if actual.reference != candidate.reference {
                                            continue;
                                        }
                                        if actual.name != candidate.name {
                                            return Err(invalid(ValidationReason::InvalidState));
                                        }
                                        by_name_candidates
                                            .entry(actual.name.clone())
                                            .or_default()
                                            .push(actual);
                                    }
                                }
                            }
                            if !bulk_complete {
                                for item in &page_candidates {
                                    if by_name_candidates.contains_key(&item.name) {
                                        continue;
                                    }
                                    let page = self
                                        .catalog
                                        .abilities(
                                            current.clone(),
                                            AbilityQuery {
                                                page: ControlPageRequest::new(200, None)?,
                                                project: query.project.clone(),
                                                kind: None,
                                                name: Some(item.name.clone()),
                                                authoring: false,
                                            },
                                        )
                                        .await?;
                                    if page.items.len() > 200 || page.continuation.is_some() {
                                        return Err(invalid(ValidationReason::BudgetExceeded));
                                    }
                                    let mut group = Vec::new();
                                    for candidate in page.items {
                                        if candidate.name != item.name {
                                            return Err(invalid(ValidationReason::InvalidState));
                                        }
                                        if !role_placement_matches_project(
                                            &candidate.reference.placement,
                                            query.project.as_ref(),
                                        ) {
                                            continue;
                                        }
                                        let Some(actual) = self
                                            .raw_ability_cached(
                                                &current,
                                                candidate.reference.identity(),
                                                &mut checked_spaces,
                                                &mut checked_projects,
                                                &mut raw_cache,
                                            )
                                            .await?
                                        else {
                                            continue;
                                        };
                                        if actual.reference != candidate.reference {
                                            continue;
                                        }
                                        if actual.name != item.name {
                                            return Err(invalid(ValidationReason::InvalidState));
                                        }
                                        group.push(actual);
                                    }
                                    by_name_candidates.insert(item.name.clone(), group);
                                }
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
                    Ok((page_candidates, by_name_candidates, continuation))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        if page_candidates.is_empty() {
            return Ok(ControlPage {
                items: Vec::new(),
                continuation,
            });
        }
        let mut rtx = self.store.read(budget.clone()).await?;
        let items = budget
            .run(
                async {
                    let mut items = Vec::new();
                    if query.authoring {
                        for value in page_candidates {
                            items.push(
                                self.overlay(
                                    rtx.inner_mut(),
                                    &current,
                                    value,
                                    query.project.as_ref(),
                                )
                                .await?,
                            );
                        }
                    } else {
                        let mut winners: BTreeMap<String, Option<AbilityDescriptor>> =
                            BTreeMap::new();
                        for (name, candidates) in by_name_candidates {
                            let winner = self
                                .select_overlaid_winner(
                                    rtx.inner_mut(),
                                    &current,
                                    query.project.as_ref(),
                                    candidates,
                                )
                                .await?;
                            winners.insert(name, winner.filter(|w| w.enabled && w.healthy));
                        }
                        for candidate in page_candidates {
                            if let Some(winner) =
                                winners.get(&candidate.name).and_then(Clone::clone)
                                && winner.kind == candidate.kind
                                && winner.reference == candidate.reference
                            {
                                items.push(winner);
                            }
                        }
                    }
                    Ok::<_, PortError>(items)
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        Ok(ControlPage {
            items: items?,
            continuation,
        })
    }
}
