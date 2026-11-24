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
async fn ability_control_state(
    tx: &mut Transaction,
    owner: &PrincipalId,
    key: &str,
    id: &AbilityId,
) -> Result<
    (
        Option<AbilityAvailabilityRow>,
        Option<AbilityPreferencesRow>,
    ),
    PortError,
> {
    let binding = rows!(tx,AbilityAvailabilityRow,fetch_optional,
        "SELECT * FROM ability_availability WHERE placement=$1 AND ability_id=$2",
        "SELECT * FROM v1_control.ability_availability WHERE placement=$1 AND ability_id=$2";key,id.as_str())?;
    let preference = ability_preference(tx, owner, key, id).await?;
    Ok((binding, preference))
}

async fn ability_preference(
    tx: &mut Transaction,
    owner: &PrincipalId,
    key: &str,
    id: &AbilityId,
) -> Result<Option<AbilityPreferencesRow>, PortError> {
    rows!(tx,AbilityPreferencesRow,fetch_optional,
        "SELECT * FROM ability_preferences WHERE owner_id=$1 AND placement=$2 AND ability_id=$3",
        "SELECT * FROM v1_control.ability_preferences WHERE owner_id=$1 AND placement=$2 AND ability_id=$3";owner.as_str(),key,id.as_str())
}

fn overlay_state(
    binding: Option<&AbilityAvailabilityRow>,
    preference: Option<&AbilityPreferencesRow>,
) -> Result<AbilityOverlayState, PortError> {
    Ok(AbilityOverlayState {
        binding_enabled: binding.is_none_or(|row| row.enabled == 1),
        binding_revision: binding
            .map(|row| ControlRevision::new(row.revision as u64))
            .transpose()?,
        preference_enabled: preference.is_none_or(|row| row.enabled == 1),
        preference_revision: preference
            .map(|row| ControlRevision::new(row.revision as u64))
            .transpose()?,
    })
}

fn trail_matches_promotion(
    row: Option<&AbilityPlacementTrailRow>,
    source: Option<&AbilityRef>,
    destination: &AbilityIdentity,
) -> Result<bool, PortError> {
    let Some(source) = source else {
        return Ok(true);
    };
    let Some(row) = row else {
        return Ok(false);
    };
    let trail: Trail = serde_json::from_str(&row.manifest_ref)
        .map_err(|_| invalid(ValidationReason::InvalidState))?;
    Ok(trail.source == *source
        && trail.destination.identity() == *destination
        && trail.destination.revision != source.revision
        && row.destination_id == destination.id.as_str()
        && row.destination_placement == placement(&destination.placement)?)
}

fn apply_overlay(
    mut value: AbilityDescriptor,
    promotion_committed: bool,
    availability: Option<&AbilityAvailabilityRow>,
    preference: Option<&AbilityPreferencesRow>,
    project_selected: bool,
) -> Result<AbilityDescriptor, PortError> {
    if !promotion_committed {
        value.enabled = false;
    }
    if value.requires_explicit_binding && availability.is_none() {
        value.enabled = false;
    }
    if let Some(row) = availability {
        value.enabled &= row.enabled == 1;
        if row.mode == "selected-projects" {
            value.enabled &= project_selected;
        } else if row.mode != "all-projects" {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    if let Some(row) = preference {
        value.enabled &= row.enabled == 1;
    }
    Ok(value)
}

#[derive(sqlx::FromRow)]
struct MatchedBindingKey {
    placement: String,
    ability_id: String,
}

async fn load_project_bindings_batch(
    tx: &mut Transaction,
    selected_keys: &[(String, String)],
) -> Result<BTreeMap<(String, String), Vec<AbilityProjectBindingsRow>>, PortError> {
    let mut project_bindings: BTreeMap<(String, String), Vec<AbilityProjectBindingsRow>> =
        BTreeMap::new();
    if selected_keys.is_empty() {
        return Ok(project_bindings);
    }
    let unique: Vec<(String, String)> = selected_keys
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let binding_rows = match tx {
        Transaction::Sqlite(conn) => {
            let keys_json = serde_json::to_string(&unique)
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
            sqlx::query_as::<_, AbilityProjectBindingsRow>(
                "SELECT placement, ability_id, target_space, project_id FROM ( \
                   SELECT b.placement, b.ability_id, b.target_space, b.project_id, \
                          ROW_NUMBER() OVER (PARTITION BY b.placement, b.ability_id ORDER BY b.target_space, b.project_id) AS rn \
                   FROM (SELECT json_extract(value, '$[0]') AS pl, json_extract(value, '$[1]') AS id FROM json_each($1)) k \
                   CROSS JOIN ability_project_bindings b \
                   WHERE b.placement = k.pl AND b.ability_id = k.id \
                 ) WHERE rn <= 201 ORDER BY placement, ability_id, target_space, project_id",
            )
            .bind(keys_json)
            .fetch_all(&mut **conn)
            .await
            .map_err(crate::error::database)?
        }
        Transaction::Postgres(conn) => {
            let (pls, ids): (Vec<String>, Vec<String>) = unique.into_iter().unzip();
            sqlx::query_as::<_, AbilityProjectBindingsRow>(
                "SELECT b.placement, b.ability_id, b.target_space, b.project_id \
                 FROM unnest($1::text[], $2::text[]) AS k(pl, id) \
                 CROSS JOIN LATERAL ( \
                   SELECT b.placement, b.ability_id, b.target_space, b.project_id \
                   FROM v1_control.ability_project_bindings b \
                   WHERE b.placement = k.pl AND b.ability_id = k.id \
                   ORDER BY b.target_space, b.project_id \
                   LIMIT 201 \
                 ) b \
                 ORDER BY b.placement, b.ability_id, b.target_space, b.project_id",
            )
            .bind(pls)
            .bind(ids)
            .fetch_all(&mut **conn)
            .await
            .map_err(crate::error::database)?
        }
    };
    for row in binding_rows {
        project_bindings
            .entry((row.placement.clone(), row.ability_id.clone()))
            .or_default()
            .push(row);
    }
    Ok(project_bindings)
}

struct BatchedAbilityControl {
    availability: BTreeMap<(String, String), AbilityAvailabilityRow>,
    preferences: BTreeMap<(String, String), AbilityPreferencesRow>,
    trails: BTreeMap<(String, String), AbilityPlacementTrailRow>,
    matched_projects: BTreeSet<(String, String)>,
}

impl BatchedAbilityControl {
    async fn load(
        tx: &mut Transaction,
        owner: &PrincipalId,
        candidates: &[(String, String)],
        trail_sources: &[(String, String)],
        project: Option<&FolderRef>,
    ) -> Result<Self, PortError> {
        let mut availability = BTreeMap::new();
        let mut preferences = BTreeMap::new();
        let mut trails = BTreeMap::new();
        let mut matched_projects = BTreeSet::new();
        if !candidates.is_empty() {
            let (avail_rows, pref_rows) = match tx {
                Transaction::Sqlite(conn) => {
                    let keys_json = serde_json::to_string(candidates)
                        .map_err(|_| invalid(ValidationReason::InvalidState))?;
                    let avail = sqlx::query_as::<_, AbilityAvailabilityRow>(
                        "SELECT a.placement, a.ability_id, a.mode, a.enabled, a.revision \
                         FROM (SELECT json_extract(value, '$[0]') AS pl, json_extract(value, '$[1]') AS id FROM json_each($1)) k \
                         CROSS JOIN ability_availability a \
                         WHERE a.placement = k.pl AND a.ability_id = k.id",
                    )
                    .bind(&keys_json)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(crate::error::database)?;
                    let prefs = sqlx::query_as::<_, AbilityPreferencesRow>(
                        "SELECT p.owner_id, p.ability_id, p.placement, p.enabled, p.revision \
                         FROM (SELECT json_extract(value, '$[0]') AS pl, json_extract(value, '$[1]') AS id FROM json_each($2)) k \
                         CROSS JOIN ability_preferences p \
                         WHERE p.owner_id = $1 AND p.ability_id = k.id AND p.placement = k.pl",
                    )
                    .bind(owner.as_str())
                    .bind(&keys_json)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(crate::error::database)?;
                    (avail, prefs)
                }
                Transaction::Postgres(conn) => {
                    let (pls, ids): (Vec<String>, Vec<String>) = candidates.iter().cloned().unzip();
                    let avail = sqlx::query_as::<_, AbilityAvailabilityRow>(
                        "SELECT a.placement, a.ability_id, a.mode, a.enabled, a.revision \
                         FROM unnest($1::text[], $2::text[]) AS k(pl, id) \
                         JOIN v1_control.ability_availability a \
                           ON a.placement = k.pl AND a.ability_id = k.id",
                    )
                    .bind(&pls)
                    .bind(&ids)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(crate::error::database)?;
                    let prefs = sqlx::query_as::<_, AbilityPreferencesRow>(
                        "SELECT p.owner_id, p.ability_id, p.placement, p.enabled, p.revision \
                         FROM unnest($2::text[], $3::text[]) AS k(pl, id) \
                         JOIN v1_control.ability_preferences p \
                           ON p.owner_id = $1 AND p.ability_id = k.id AND p.placement = k.pl",
                    )
                    .bind(owner.as_str())
                    .bind(&pls)
                    .bind(&ids)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(crate::error::database)?;
                    (avail, prefs)
                }
            };
            let mut selected_keys = Vec::new();
            for row in avail_rows {
                let key = (row.placement.clone(), row.ability_id.clone());
                let is_selected = row.mode == "selected-projects";
                if availability.insert(key.clone(), row).is_none() && is_selected {
                    selected_keys.push(key);
                }
            }
            for row in pref_rows {
                preferences.insert((row.placement.clone(), row.ability_id.clone()), row);
            }
            if let Some(project) = project
                && !selected_keys.is_empty()
            {
                let matched_rows = match tx {
                    Transaction::Sqlite(conn) => {
                        let keys_json = serde_json::to_string(&selected_keys)
                            .map_err(|_| invalid(ValidationReason::InvalidState))?;
                        sqlx::query_as::<_, MatchedBindingKey>(
                            "SELECT b.placement, b.ability_id \
                             FROM (SELECT json_extract(value, '$[0]') AS pl, json_extract(value, '$[1]') AS id FROM json_each($1)) k \
                             CROSS JOIN ability_project_bindings b \
                             WHERE b.placement = k.pl AND b.ability_id = k.id \
                               AND b.target_space = $2 AND b.project_id = $3",
                        )
                        .bind(keys_json)
                        .bind(project.space_id.as_str())
                        .bind(project.folder_id.as_str())
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(crate::error::database)?
                    }
                    Transaction::Postgres(conn) => {
                        let (pls, ids): (Vec<String>, Vec<String>) =
                            selected_keys.into_iter().unzip();
                        sqlx::query_as::<_, MatchedBindingKey>(
                            "SELECT b.placement, b.ability_id \
                             FROM unnest($1::text[], $2::text[]) AS k(pl, id) \
                             JOIN v1_control.ability_project_bindings b \
                               ON b.placement = k.pl AND b.ability_id = k.id \
                              AND b.target_space = $3 AND b.project_id = $4",
                        )
                        .bind(pls)
                        .bind(ids)
                        .bind(project.space_id.as_str())
                        .bind(project.folder_id.as_str())
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(crate::error::database)?
                    }
                };
                for row in matched_rows {
                    matched_projects.insert((row.placement, row.ability_id));
                }
            }
        }
        if !trail_sources.is_empty() {
            let trail_rows = match tx {
                Transaction::Sqlite(conn) => {
                    let keys_json = serde_json::to_string(trail_sources)
                        .map_err(|_| invalid(ValidationReason::InvalidState))?;
                    sqlx::query_as::<_, AbilityPlacementTrailRow>(
                        "SELECT t.source_placement, t.ability_id, t.destination_placement, t.destination_id, t.manifest_ref, t.created_at \
                         FROM (SELECT json_extract(value, '$[0]') AS pl, json_extract(value, '$[1]') AS id FROM json_each($1)) k \
                         CROSS JOIN ability_placement_trail t \
                         WHERE t.source_placement = k.pl AND t.ability_id = k.id",
                    )
                    .bind(keys_json)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(crate::error::database)?
                }
                Transaction::Postgres(conn) => {
                    let (pls, ids): (Vec<String>, Vec<String>) =
                        trail_sources.iter().cloned().unzip();
                    sqlx::query_as::<_, AbilityPlacementTrailRow>(
                        "SELECT t.source_placement, t.ability_id, t.destination_placement, t.destination_id, t.manifest_ref, t.created_at \
                         FROM unnest($1::text[], $2::text[]) AS k(pl, id) \
                         JOIN v1_control.ability_placement_trail t \
                           ON t.source_placement = k.pl AND t.ability_id = k.id",
                    )
                    .bind(pls)
                    .bind(ids)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(crate::error::database)?
                }
            };
            for row in trail_rows {
                trails.insert((row.source_placement.clone(), row.ability_id.clone()), row);
            }
        }
        Ok(Self {
            availability,
            preferences,
            trails,
            matched_projects,
        })
    }

    fn promotion_is_committed(
        &self,
        source: Option<&AbilityRef>,
        destination: &AbilityIdentity,
    ) -> Result<bool, PortError> {
        let row = match source {
            Some(source) => {
                let key = (placement(&source.placement)?, source.id.to_string());
                self.trails.get(&key)
            }
            None => None,
        };
        trail_matches_promotion(row, source, destination)
    }

    fn overlay(&self, value: AbilityDescriptor) -> Result<AbilityDescriptor, PortError> {
        let promotion_committed =
            self.promotion_is_committed(value.promoted_from.as_ref(), &value.reference.identity())?;
        let key = (
            placement(&value.reference.placement)?,
            value.reference.id.to_string(),
        );
        let availability = self.availability.get(&key);
        let preference = self.preferences.get(&key);
        let project_selected = self.matched_projects.contains(&key);
        apply_overlay(
            value,
            promotion_committed,
            availability,
            preference,
            project_selected,
        )
    }

    fn select_overlaid_winners(
        &self,
        candidates: Vec<AbilityDescriptor>,
    ) -> Result<Vec<AbilityDescriptor>, PortError> {
        let mut winners: Vec<AbilityDescriptor> = Vec::new();
        for current in candidates {
            if !self.promotion_is_committed(
                current.promoted_from.as_ref(),
                &current.reference.identity(),
            )? {
                continue;
            }
            let candidate = self.overlay(current)?;
            if let Some(previous) = winners.first() {
                let level = candidate
                    .reference
                    .placement
                    .precedence()
                    .cmp(&previous.reference.placement.precedence());
                if level.is_gt() {
                    continue;
                }
                if level.is_eq() {
                    if winners.iter().all(|existing| {
                        existing.reference.identity() != candidate.reference.identity()
                    }) {
                        winners.push(candidate);
                    }
                    continue;
                }
            }
            winners.clear();
            winners.push(candidate);
        }
        Ok(winners)
    }

    fn select_overlaid_winner(
        &self,
        candidates: Vec<AbilityDescriptor>,
    ) -> Result<Option<AbilityDescriptor>, PortError> {
        let mut winners = self.select_overlaid_winners(candidates)?;
        match winners.len() {
            0 => Ok(None),
            1 => Ok(winners.pop()),
            _ => Err(invalid(ValidationReason::InvalidState)),
        }
    }
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
    async fn prefetch_projects(
        &self,
        ctx: &AccountContext,
        candidates: impl IntoIterator<Item = FolderRef>,
        checked_projects: &mut BTreeMap<(SpaceId, FolderId), bool>,
    ) -> Result<(), PortError> {
        let mut missing = Vec::new();
        let mut seen = BTreeSet::new();
        for project in candidates {
            let key = (project.space_id.clone(), project.folder_id.clone());
            if !checked_projects.contains_key(&key) && seen.insert(key) {
                missing.push(project);
            }
        }
        if missing.is_empty() {
            return Ok(());
        }
        let existing: BTreeSet<(SpaceId, FolderId)> = self
            .catalog
            .existing_projects(ctx.clone(), missing.clone())
            .await?
            .into_iter()
            .map(|project| (project.space_id, project.folder_id))
            .collect();
        for project in missing {
            let key = (project.space_id, project.folder_id);
            let exists = existing.contains(&key);
            checked_projects.insert(key, exists);
        }
        Ok(())
    }
    async fn ability_placement_cached(
        &self,
        ctx: &AccountContext,
        value: &AbilityPlacement,
        checked_spaces: &mut BTreeMap<SpaceId, bool>,
        checked_projects: &mut BTreeMap<(SpaceId, FolderId), bool>,
    ) -> Result<(), PortError> {
        match value {
            AbilityPlacement::OwnedPersonal(owner) if owner != ctx.auth().principal() => {
                Err(DomainError::ResourceNotFound.into())
            }
            AbilityPlacement::OwnedSpace(space) => match checked_spaces.get(space) {
                Some(true) => Ok(()),
                Some(false) => Err(DomainError::ResourceNotFound.into()),
                None => match self.catalog_space(ctx, space).await {
                    Ok(_) => {
                        checked_spaces.insert(space.clone(), true);
                        Ok(())
                    }
                    Err(error) if hidden(&error) => {
                        checked_spaces.insert(space.clone(), false);
                        Err(error)
                    }
                    Err(error) => Err(error),
                },
            },
            AbilityPlacement::OwnedProject(project) => {
                let key = (project.space_id.clone(), project.folder_id.clone());
                match checked_projects.get(&key) {
                    Some(true) => Ok(()),
                    Some(false) => Err(DomainError::ResourceNotFound.into()),
                    None => match self.catalog_project(ctx, project).await {
                        Ok(_) => {
                            checked_projects.insert(key, true);
                            Ok(())
                        }
                        Err(error) if hidden(&error) => {
                            checked_projects.insert(key, false);
                            Err(error)
                        }
                        Err(error) => Err(error),
                    },
                }
            }
            _ => Ok(()),
        }
    }
    pub(super) async fn raw_ability(
        &self,
        ctx: &AccountContext,
        identity: AbilityIdentity,
    ) -> Result<AbilityDescriptor, PortError> {
        let mut spaces = BTreeMap::new();
        let mut projects = BTreeMap::new();
        self.raw_ability_uncached(ctx, identity, &mut spaces, &mut projects)
            .await
    }
    async fn raw_ability_uncached(
        &self,
        ctx: &AccountContext,
        identity: AbilityIdentity,
        checked_spaces: &mut BTreeMap<SpaceId, bool>,
        checked_projects: &mut BTreeMap<(SpaceId, FolderId), bool>,
    ) -> Result<AbilityDescriptor, PortError> {
        self.ability_placement_cached(ctx, &identity.placement, checked_spaces, checked_projects)
            .await?;
        let tip = self
            .catalog
            .current_ability(ctx.clone(), identity.clone())
            .await?;
        if tip.reference.identity() != identity {
            return Err(invalid(ValidationReason::InvalidState));
        }
        // A package tip may predate a move of its entrypoint. The exact lookup
        // also checks the placement where this manifest was published.
        let value = self
            .catalog
            .ability(ctx.clone(), tip.reference.clone())
            .await?;
        if value.reference != tip.reference {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if valid_name(&value.name).is_err()
            || value.auxiliary_files.len() > MAX_ABILITY_AUX_FILES
            || value.auxiliary_files.iter().any(|name| {
                name.is_empty() || name.len() > MAX_ABILITY_AUX_PATH_BYTES || name.contains('\0')
            })
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if value.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        if identity.placement != AbilityPlacement::System {
            let entrypoint = value
                .entrypoint
                .as_ref()
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let note = self.catalog_note(ctx, entrypoint).await?;
            if note.facts.class != DocClass::Skill
                || note.facts.ability_package.as_ref() != Some(&identity.id)
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            match identity.placement {
                AbilityPlacement::OwnedSpace(space) if space != entrypoint.space_id => {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                AbilityPlacement::OwnedProject(project)
                    if project.space_id != entrypoint.space_id
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
        } else if value.entrypoint.is_some() {
            return Err(invalid(ValidationReason::InvalidState));
        }
        Ok(value)
    }
    async fn raw_ability_cached(
        &self,
        ctx: &AccountContext,
        identity: AbilityIdentity,
        checked_spaces: &mut BTreeMap<SpaceId, bool>,
        checked_projects: &mut BTreeMap<(SpaceId, FolderId), bool>,
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
        value: AbilityDescriptor,
        project: Option<&FolderRef>,
    ) -> Result<AbilityDescriptor, PortError> {
        let promotion_committed = self
            .promotion_is_committed(
                tx,
                value.promoted_from.as_ref(),
                &value.reference.identity(),
            )
            .await?;
        let key = placement(&value.reference.placement)?;
        let id = &value.reference.id;
        let (availability, preference) =
            ability_control_state(tx, ctx.auth().principal(), &key, id).await?;
        let project_selected = if availability
            .as_ref()
            .is_some_and(|row| row.mode == "selected-projects")
        {
            if let Some(project) = project {
                rows!(tx,AbilityProjectBindingsRow,fetch_optional,"SELECT * FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4","SELECT * FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4";&key,id.as_str(),project.space_id.as_str(),project.folder_id.as_str())?.is_some()
            } else {
                false
            }
        } else {
            false
        };
        apply_overlay(
            value,
            promotion_committed,
            availability.as_ref(),
            preference.as_ref(),
            project_selected,
        )
    }

    pub(super) async fn promotion_is_committed(
        &self,
        tx: &mut Transaction,
        source: Option<&AbilityRef>,
        destination: &AbilityIdentity,
    ) -> Result<bool, PortError> {
        let Some(source) = source else {
            return Ok(true);
        };
        let key = placement(&source.placement)?;
        let row = rows!(tx,AbilityPlacementTrailRow,fetch_optional,
            "SELECT * FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2",
            "SELECT * FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,source.id.as_str())?;
        trail_matches_promotion(row.as_ref(), Some(source), destination)
    }

    pub(super) async fn ability_admitted_for_provider(
        &self,
        tx: &mut Transaction,
        identity: &AbilityIdentity,
        effective_project: Option<&FolderRef>,
        requires_explicit_binding: bool,
    ) -> Result<bool, PortError> {
        let key = placement(&identity.placement)?;
        let row = rows!(
            tx,
            AbilityAvailabilityRow,
            fetch_optional,
            "SELECT * FROM ability_availability WHERE placement=$1 AND ability_id=$2",
            "SELECT * FROM v1_control.ability_availability WHERE placement=$1 AND ability_id=$2";
            &key,
            identity.id.as_str()
        )?;
        let Some(row) = row else {
            return Ok(!requires_explicit_binding);
        };
        if row.enabled != 1 {
            return Ok(false);
        }
        match row.mode.as_str() {
            "all-projects" => Ok(true),
            "selected-projects" => {
                let Some(project) = effective_project else {
                    return Ok(false);
                };
                Ok(rows!(
                    tx,
                    AbilityProjectBindingsRow,
                    fetch_optional,
                    "SELECT * FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4",
                    "SELECT * FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4";
                    &key,
                    identity.id.as_str(),
                    project.space_id.as_str(),
                    project.folder_id.as_str()
                )?
                .is_some())
            }
            _ => Err(invalid(ValidationReason::InvalidState)),
        }
    }
    pub(super) async fn check_active_role_catalog(
        &self,
        ctx: &AccountContext,
        followed: Result<AbilityRef, PortError>,
        project: Option<&FolderRef>,
    ) -> Result<Option<AbilityDescriptor>, PortError> {
        let final_ref = match followed {
            Ok(reference) => reference,
            Err(error) if hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        if !role_placement_matches_project(&final_ref.placement, project) {
            return Ok(None);
        }
        match self.ability_placement(ctx, &final_ref.placement).await {
            Ok(()) => (),
            Err(error) if hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        }
        let raw = match self.raw_ability(ctx, final_ref.identity()).await {
            Ok(raw) => raw,
            Err(error) if hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        if raw.reference != final_ref || raw.kind != AbilityKind::Role || !raw.healthy {
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
                let (value, followed_reference, effective_project) = match budget
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
                            let effective = match &reference.placement {
                                AbilityPlacement::OwnedProject(placement) => {
                                    Some(placement.clone())
                                }
                                _ => project,
                            };
                            Ok(Ok((value, reference, effective)))
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?
                {
                    Ok(triple) => triple,
                    Err(early) => return Ok(early),
                };
                let mut rtx = self.store.read(budget.clone()).await?;
                let resolved = budget
                    .run(
                        async {
                            if !self
                                .promotion_is_committed(
                                    rtx.inner_mut(),
                                    value.promoted_from.as_ref(),
                                    &value.reference.identity(),
                                )
                                .await?
                            {
                                return Ok(AbilityResolution::Missing);
                            }
                            if value.reference != followed_reference {
                                return Ok(AbilityResolution::Stale);
                            }
                            let overlaid = self
                                .overlay(
                                    rtx.inner_mut(),
                                    &current,
                                    value,
                                    effective_project.as_ref(),
                                )
                                .await?;
                            Ok(classify_resolution(Some(overlaid), None))
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await;
                budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
                resolved
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
                            let mut checked_spaces = BTreeMap::new();
                            let mut checked_projects = BTreeMap::new();
                            let mut raw_cache = BTreeMap::new();
                            if let Some(project) = &project {
                                self.catalog_project(&current, project).await?;
                                checked_projects.insert(
                                    (project.space_id.clone(), project.folder_id.clone()),
                                    true,
                                );
                                checked_spaces.insert(project.space_id.clone(), true);
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
                let mut candidate_keys = BTreeSet::new();
                let mut trail_keys = BTreeSet::new();
                for descriptor in &candidates {
                    candidate_keys.insert((
                        placement(&descriptor.reference.placement)?,
                        descriptor.reference.id.to_string(),
                    ));
                    if let Some(source) = &descriptor.promoted_from {
                        trail_keys.insert((placement(&source.placement)?, source.id.to_string()));
                    }
                }
                let candidate_keys: Vec<(String, String)> = candidate_keys.into_iter().collect();
                let trail_keys: Vec<(String, String)> = trail_keys.into_iter().collect();
                let mut rtx = self.store.read(budget.clone()).await?;
                let winner = budget
                    .run(
                        async {
                            let batched = BatchedAbilityControl::load(
                                rtx.inner_mut(),
                                current.auth().principal(),
                                &candidate_keys,
                                &trail_keys,
                                project.as_ref(),
                            )
                            .await?;
                            batched.select_overlaid_winner(candidates)
                        },
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
    pub async fn inspect_ability(
        &self,
        ctx: AccountContext,
        identity: AbilityIdentity,
    ) -> Result<AbilityInspection, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let current = self.current_account(&ctx, &budget).await?;
        let mut descriptor = budget
            .run(
                self.raw_ability(&current, identity.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        let key = placement(&identity.placement)?;
        let mut rtx = self.store.read(budget.clone()).await?;
        let state = budget.run(async {
            let tx = rtx.inner_mut();
            if !self.promotion_is_committed(tx, descriptor.promoted_from.as_ref(), &identity).await? {
                return Err(DomainError::ResourceNotFound.into());
            }
            let (binding, preference) =
                ability_control_state(tx, current.auth().principal(), &key, &identity.id).await?;
            let selected = match binding.as_ref().map(|row| row.mode.as_str()) {
                None | Some("all-projects") => None,
                Some("selected-projects") => {
                    let rows = rows!(tx,AbilityProjectBindingsRow,fetch_all,
                        "SELECT * FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2 ORDER BY target_space,project_id LIMIT 201",
                        "SELECT * FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2 ORDER BY target_space,project_id LIMIT 201";&key,identity.id.as_str())?;
                    if rows.len() > 200 {
                        return Err(invalid(ValidationReason::BudgetExceeded));
                    }
                    Some(rows)
                }
                _ => return Err(invalid(ValidationReason::InvalidState)),
            };
            Ok((binding, preference, selected))
        }, CommitEffect::NotCommitted).await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let (binding, preference, selected) = state?;
        let binding_pending = descriptor.requires_explicit_binding && binding.is_none();
        if binding_pending {
            descriptor.enabled = false;
        }
        let availability = budget
            .run(
                async {
                    let Some(selected) = selected else {
                        return Ok(if binding_pending {
                            AbilityProjects::Selected(Vec::new())
                        } else {
                            AbilityProjects::All
                        });
                    };
                    let parsed: Vec<FolderRef> = selected
                        .into_iter()
                        .map(|row| {
                            Ok(FolderRef {
                                space_id: SpaceId::parse(&row.target_space)?,
                                folder_id: FolderId::parse(&row.project_id)?,
                            })
                        })
                        .collect::<Result<Vec<_>, PortError>>()?;
                    let existing: BTreeSet<(SpaceId, FolderId)> = self
                        .catalog
                        .existing_projects(current.clone(), parsed.clone())
                        .await?
                        .into_iter()
                        .map(|project| (project.space_id, project.folder_id))
                        .collect();
                    let projects = parsed
                        .into_iter()
                        .filter(|project| {
                            existing
                                .contains(&(project.space_id.clone(), project.folder_id.clone()))
                        })
                        .collect();
                    Ok(AbilityProjects::Selected(projects))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        let state = overlay_state(binding.as_ref(), preference.as_ref())?;
        Ok(AbilityInspection {
            descriptor,
            availability,
            binding_enabled: state.binding_enabled,
            preference_enabled: state.preference_enabled,
            binding_revision: state.binding_revision.unwrap_or(ControlRevision::ZERO),
            overlays: state,
        })
    }
    async fn ability_scope(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        query: &AbilityQuery,
    ) -> Result<ContentDigest, PortError> {
        let owner = user_read(tx, ctx.auth().principal().as_str()).await?;
        let spaces: Vec<&SpaceId> = ctx.auth().spaces().keys().collect();
        let revisions = super::spaces::admission_revisions(tx, &spaces).await?;
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
    async fn validate_listed_ability(
        &self,
        ctx: &AccountContext,
        candidate: AbilityDescriptor,
        checked_spaces: &mut BTreeMap<SpaceId, bool>,
        checked_projects: &mut BTreeMap<(SpaceId, FolderId), bool>,
    ) -> Result<Option<AbilityDescriptor>, PortError> {
        if valid_name(&candidate.name).is_err()
            || candidate.auxiliary_files.len() > MAX_ABILITY_AUX_FILES
            || candidate.auxiliary_files.iter().any(|name| {
                name.is_empty() || name.len() > MAX_ABILITY_AUX_PATH_BYTES || name.contains('\0')
            })
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if candidate.lifecycle != Lifecycle::Active {
            return Ok(None);
        }
        match &candidate.reference.placement {
            AbilityPlacement::System => {
                if candidate.entrypoint.is_some() {
                    return Err(invalid(ValidationReason::InvalidState));
                }
            }
            AbilityPlacement::OwnedSpace(space) => {
                let entrypoint = candidate
                    .entrypoint
                    .as_ref()
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                if &entrypoint.space_id != space {
                    return Err(invalid(ValidationReason::InvalidState));
                }
            }
            AbilityPlacement::OwnedProject(project) => {
                let entrypoint = candidate
                    .entrypoint
                    .as_ref()
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                if entrypoint.space_id != project.space_id {
                    return Err(invalid(ValidationReason::InvalidState));
                }
            }
            AbilityPlacement::OwnedPersonal(_) => {
                if candidate.entrypoint.is_none() {
                    return Err(invalid(ValidationReason::InvalidState));
                }
            }
        }
        match self
            .ability_placement_cached(
                ctx,
                &candidate.reference.placement,
                checked_spaces,
                checked_projects,
            )
            .await
        {
            Ok(()) => Ok(Some(candidate)),
            Err(error) if hidden(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }
    pub async fn discover_abilities(
        &self,
        ctx: AccountContext,
        query: AbilityQuery,
    ) -> Result<ControlPage<AbilityInspection>, PortError> {
        if let Some(name) = &query.name {
            valid_name(name)?;
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let scope_result = budget
            .run(
                self.ability_scope(rtx.inner_mut(), &current, &query),
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let scope = scope_result?;
        let (page_candidates, by_name_candidates, continuation, mut checked_projects) = budget
            .run(
                async {
                    let mut checked_spaces = BTreeMap::new();
                    let mut checked_projects = BTreeMap::new();
                    if let Some(project) = &query.project {
                        self.catalog_project(&current, project).await?;
                        checked_projects
                            .insert((project.space_id.clone(), project.folder_id.clone()), true);
                        checked_spaces.insert(project.space_id.clone(), true);
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
                    self.prefetch_projects(
                        &current,
                        raw.items.iter().filter_map(|candidate| {
                            match &candidate.reference.placement {
                                AbilityPlacement::OwnedProject(project) => Some(project.clone()),
                                _ => None,
                            }
                        }),
                        &mut checked_projects,
                    )
                    .await?;
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
                        if (!query.authoring || query.project.is_some())
                            && !role_placement_matches_project(
                                &candidate.reference.placement,
                                query.project.as_ref(),
                            )
                        {
                            continue;
                        }
                        let Some(value) = self
                            .validate_listed_ability(
                                &current,
                                candidate,
                                &mut checked_spaces,
                                &mut checked_projects,
                            )
                            .await?
                        else {
                            continue;
                        };
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
                                    self.prefetch_projects(
                                        &current,
                                        all.items.iter().filter_map(|candidate| {
                                            match &candidate.reference.placement {
                                                AbilityPlacement::OwnedProject(project) => {
                                                    Some(project.clone())
                                                }
                                                _ => None,
                                            }
                                        }),
                                        &mut checked_projects,
                                    )
                                    .await?;
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
                                            .validate_listed_ability(
                                                &current,
                                                candidate,
                                                &mut checked_spaces,
                                                &mut checked_projects,
                                            )
                                            .await?
                                        else {
                                            continue;
                                        };
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
                                    self.prefetch_projects(
                                        &current,
                                        page.items.iter().filter_map(|candidate| match &candidate
                                            .reference
                                            .placement
                                        {
                                            AbilityPlacement::OwnedProject(project) => {
                                                Some(project.clone())
                                            }
                                            _ => None,
                                        }),
                                        &mut checked_projects,
                                    )
                                    .await?;
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
                                            .validate_listed_ability(
                                                &current,
                                                candidate,
                                                &mut checked_spaces,
                                                &mut checked_projects,
                                            )
                                            .await?
                                        else {
                                            continue;
                                        };
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
                    Ok((
                        page_candidates,
                        by_name_candidates,
                        continuation,
                        checked_projects,
                    ))
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
        let mut candidate_keys = BTreeSet::new();
        let mut trail_keys = BTreeSet::new();
        for descriptor in page_candidates
            .iter()
            .chain(by_name_candidates.values().flat_map(|items| items.iter()))
        {
            candidate_keys.insert((
                placement(&descriptor.reference.placement)?,
                descriptor.reference.id.to_string(),
            ));
            if let Some(source) = &descriptor.promoted_from {
                trail_keys.insert((placement(&source.placement)?, source.id.to_string()));
            }
        }
        let candidate_keys: Vec<(String, String)> = candidate_keys.into_iter().collect();
        let trail_keys: Vec<(String, String)> = trail_keys.into_iter().collect();
        let mut rtx = self.store.read(budget.clone()).await?;
        let rows_with_state = budget
            .run(
                async {
                    let batched = BatchedAbilityControl::load(
                        rtx.inner_mut(),
                        current.auth().principal(),
                        &candidate_keys,
                        &trail_keys,
                        query.project.as_ref(),
                    )
                    .await?;
                    let mut selected_descriptors = Vec::new();
                    if query.authoring {
                        for value in page_candidates {
                            if !batched.promotion_is_committed(
                                value.promoted_from.as_ref(),
                                &value.reference.identity(),
                            )? {
                                continue;
                            }
                            selected_descriptors.push(batched.overlay(value)?);
                        }
                    } else {
                        let mut winners: BTreeMap<String, Vec<AbilityDescriptor>> = BTreeMap::new();
                        for (name, candidates) in by_name_candidates {
                            let chosen = batched
                                .select_overlaid_winners(candidates)?
                                .into_iter()
                                .filter(|w| w.enabled && w.healthy)
                                .collect();
                            winners.insert(name, chosen);
                        }
                        for candidate in page_candidates {
                            if let Some(winner) = winners.get(&candidate.name).and_then(|list| {
                                list.iter().find(|w| {
                                    w.kind == candidate.kind && w.reference == candidate.reference
                                })
                            }) {
                                selected_descriptors.push(winner.clone());
                            }
                        }
                    }
                    let mut selected_binding_keys = Vec::new();
                    for descriptor in &selected_descriptors {
                        let key = (
                            placement(&descriptor.reference.placement)?,
                            descriptor.reference.id.to_string(),
                        );
                        if batched
                            .availability
                            .get(&key)
                            .is_some_and(|row| row.mode == "selected-projects")
                        {
                            selected_binding_keys.push(key);
                        }
                    }
                    let project_bindings =
                        load_project_bindings_batch(rtx.inner_mut(), &selected_binding_keys)
                            .await?;
                    let mut out = Vec::with_capacity(selected_descriptors.len());
                    for mut descriptor in selected_descriptors {
                        let key = (
                            placement(&descriptor.reference.placement)?,
                            descriptor.reference.id.to_string(),
                        );
                        let binding = batched.availability.get(&key);
                        let preference = batched.preferences.get(&key);
                        let selected = match binding.map(|row| row.mode.as_str()) {
                            None | Some("all-projects") => None,
                            Some("selected-projects") => {
                                let rows = project_bindings.get(&key).cloned().unwrap_or_default();
                                if rows.len() > 200 {
                                    return Err(invalid(ValidationReason::BudgetExceeded));
                                }
                                Some(rows)
                            }
                            _ => return Err(invalid(ValidationReason::InvalidState)),
                        };
                        let binding_pending =
                            descriptor.requires_explicit_binding && binding.is_none();
                        if binding_pending {
                            descriptor.enabled = false;
                        }
                        let state = overlay_state(binding, preference)?;
                        out.push((descriptor, binding_pending, selected, state));
                    }
                    Ok::<_, PortError>(out)
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let rows_with_state = rows_with_state?;
        let items = budget
            .run(
                async {
                    let mut to_prefetch = Vec::new();
                    let mut parsed_rows = Vec::with_capacity(rows_with_state.len());
                    for (descriptor, binding_pending, selected, state) in rows_with_state {
                        let selected = selected
                            .map(|rows| {
                                rows.into_iter()
                                    .map(|row| {
                                        let project = FolderRef {
                                            space_id: SpaceId::parse(&row.target_space)?,
                                            folder_id: FolderId::parse(&row.project_id)?,
                                        };
                                        to_prefetch.push(project.clone());
                                        Ok(project)
                                    })
                                    .collect::<Result<Vec<_>, PortError>>()
                            })
                            .transpose()?;
                        parsed_rows.push((descriptor, binding_pending, selected, state));
                    }
                    self.prefetch_projects(&current, to_prefetch, &mut checked_projects)
                        .await?;
                    let mut items = Vec::with_capacity(parsed_rows.len());
                    for (descriptor, binding_pending, selected, state) in parsed_rows {
                        let availability = if let Some(selected) = selected {
                            let projects = selected
                                .into_iter()
                                .filter(|project| {
                                    checked_projects
                                        .get(&(project.space_id.clone(), project.folder_id.clone()))
                                        .copied()
                                        .unwrap_or(false)
                                })
                                .collect();
                            AbilityProjects::Selected(projects)
                        } else if binding_pending {
                            AbilityProjects::Selected(Vec::new())
                        } else {
                            AbilityProjects::All
                        };
                        items.push(AbilityInspection {
                            descriptor,
                            availability,
                            binding_enabled: state.binding_enabled,
                            preference_enabled: state.preference_enabled,
                            binding_revision: state
                                .binding_revision
                                .unwrap_or(ControlRevision::ZERO),
                            overlays: state,
                        });
                    }
                    Ok::<_, PortError>(items)
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        Ok(ControlPage {
            items,
            continuation,
        })
    }
}
