//! Typed account-state payloads have the same import and service invariants.
use super::target::{AbilityTrailPayload, TargetRecord};
use super::values::{closed_json as parse, schedule_timestamp};
use crate::{error::invalid, service::validate_stored_calendar};
use notarium_core::{
    error::{PortError, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope, NoteRef},
    ports::{control::*, telemetry::*},
};
use serde::{Serialize, de::DeserializeOwned};

// These strings are SQL keys, so semantic JSON equality is insufficient. The
// importer accepts exactly the representation produced by ordinary mutations.
fn canonical<T: DeserializeOwned + Serialize>(s: &str) -> Result<T, PortError> {
    let value: T = parse(s)?;
    let encoded =
        serde_json::to_string(&value).map_err(|_| invalid(ValidationReason::InvalidState))?;
    if encoded != s {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(value)
}

fn skill_pins(value: &str) -> Result<(), PortError> {
    let refs: Vec<AbilityRef> = parse(value)?;
    if refs.len() > MAX_ATTACHED_SKILLS
        || refs.iter().enumerate().any(|(index, reference)| {
            refs[..index]
                .iter()
                .any(|other| other.identity() == reference.identity())
        })
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(())
}
fn scope(kind: &str, id: &str, space: &str, owner: &str) -> Result<(), PortError> {
    let valid = match kind {
        "personal" => id == owner,
        "space" => id == space,
        "project" => canonical::<FolderRef>(id)?.space_id.as_str() == space,
        _ => false,
    };
    if !valid {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    Ok(())
}
pub(super) fn validate(record: &TargetRecord) -> Result<(), PortError> {
    match record {
        TargetRecord::Pats {
            scope,
            ability_write,
            ..
        }
        | TargetRecord::OauthGrants {
            scope,
            ability_write,
            ..
        }
        | TargetRecord::OauthAccessTokens {
            scope,
            ability_write,
            ..
        } => {
            if !matches!(scope.as_str(), "read" | "write")
                || !matches!(ability_write, 0 | 1)
                || (*ability_write == 1 && scope != "write")
            {
                return Err(invalid(ValidationReason::InvalidAuthority));
            }
        }
        TargetRecord::ProviderResources { wire, .. } => {
            if !matches!(wire.as_str(), "openai-compatible" | "ollama") {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        TargetRecord::ProviderPreferences { model_kind, .. } => {
            if !matches!(model_kind.as_str(), "completion" | "embedding") {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        TargetRecord::AgentEpisodes {
            parent_id,
            active_role,
            name,
            ..
        } => {
            if let Some(parent) = parent_id {
                EpisodeId::parse(parent)?;
            }
            if let Some(role) = active_role {
                parse::<AbilityRef>(role)?;
            }
            if name
                .as_ref()
                .is_some_and(|name| name.is_empty() || name.chars().count() > 128)
            {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::AbilityAvailability { placement, .. } => {
            canonical::<AbilityPlacement>(placement)?;
        }
        TargetRecord::AbilityProjectBindings { placement, .. } => {
            canonical::<AbilityPlacement>(placement)?;
        }
        TargetRecord::AbilityPreferences { placement, .. } => {
            canonical::<AbilityPlacement>(placement)?;
        }
        TargetRecord::AbilityPlacementTrail {
            source_placement,
            ability_id,
            destination_placement,
            destination_id,
            manifest_ref,
            ..
        } => {
            let source: AbilityPlacement = canonical(source_placement)?;
            let destination: AbilityPlacement = canonical(destination_placement)?;
            let trail: AbilityTrailPayload = parse(manifest_ref)?;
            if trail.source.placement != source
                || trail.source.id.as_str() != ability_id
                || trail.destination.placement != destination
                || trail.destination.id.as_str() != destination_id
                || trail.source.identity() == trail.destination.identity()
            {
                return Err(invalid(ValidationReason::ScopeMismatch));
            }
        }
        TargetRecord::AgentTelemetryConfig {
            compact_retention_days,
            detailed_retention_days,
            ..
        } => {
            if !(1..=3650).contains(compact_retention_days)
                || !(1..=*compact_retention_days).contains(detailed_retention_days)
            {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::AgentCalls {
            call_id,
            owner_id,
            principal,
            agent,
            transport,
            request_id,
            tool,
            effect,
            domain,
            started_at,
            finished_at,
            duration_ms,
            outcome: raw_outcome,
            reason,
            output_bytes,
            summaries,
            fingerprint,
            projection_version,
            redacted,
            ..
        } => {
            RequestId::parse(call_id)?;
            RequestId::parse(request_id)?;
            PrincipalId::parse(principal)?;
            if let Some(agent) = agent {
                AgentRunId::parse(agent)?;
            }
            parse::<AgentOperation>(&serde_json::to_string(tool).expect("string"))?;
            parse::<AgentTransport>(&serde_json::to_string(transport).expect("string"))?;
            parse::<AgentEffect>(&serde_json::to_string(effect).expect("string"))?;
            let summary: Option<ContentDigest> = parse(summaries)?;
            let outcome: Option<AgentOutcome> = raw_outcome
                .as_ref()
                .map(|s| parse(&serde_json::to_string(s).expect("string")))
                .transpose()?;
            if let Some(reason) = reason {
                parse::<AgentFailure>(&serde_json::to_string(reason).expect("string"))?;
            }
            if domain != "control"
                || *redacted != 1
                || *projection_version != 1
                || principal != owner_id
                || fingerprint.len() != 32
                || finished_at.is_some() != outcome.is_some()
                || finished_at.is_some() != duration_ms.is_some()
                || finished_at.is_some() != output_bytes.is_some()
                || finished_at.is_some() != summary.is_some()
                || finished_at.is_some_and(|at| {
                    at < *started_at || at.checked_sub(*started_at) != *duration_ms
                })
                || (outcome == Some(AgentOutcome::Succeeded) && reason.is_some())
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        TargetRecord::AgentCallDetails {
            call_id,
            payload,
            created_at,
            expires_at,
        } => {
            RequestId::parse(call_id)?;
            let value: AgentCallDetail = parse(payload)?;
            if value.resources.len() > 200
                || value.counters.len() > 200
                || value.steps.len() > 200
                || *expires_at <= *created_at
            {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::AgentRetrievals {
            retrieval_id,
            owner_id,
            principal,
            agent,
            call_id,
            tool,
            query_summary,
            filters,
            hit_refs,
            result_count,
            top_score,
            ..
        } => {
            RequestId::parse(retrieval_id)?;
            PrincipalId::parse(principal)?;
            if let Some(agent) = agent {
                AgentRunId::parse(agent)?;
            }
            if let Some(call) = call_id {
                RequestId::parse(call)?;
            }
            parse::<RetrievalKind>(query_summary)?;
            parse::<ContentDigest>(filters)?;
            let hits: Vec<NoteRef> = parse(hit_refs)?;
            if tool != "search"
                || principal != owner_id
                || hits.len() > 200
                || *result_count < 0
                || hits.len() as i64 > *result_count
                || top_score.is_some_and(|score| !score.is_finite())
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        TargetRecord::Favorites {
            entity_kind,
            entity_id,
            ..
        } => match entity_kind.as_str() {
            "note" => {
                NoteId::parse(entity_id)?;
            }
            "folder" => {
                FolderId::parse(entity_id)?;
            }
            _ => return Err(invalid(ValidationReason::InvalidState)),
        },
        TargetRecord::ContextSets {
            set_id,
            name,
            note_refs,
            ..
        } => {
            ContextSetId::parse(set_id)?;
            let notes: Vec<NoteRef> = parse(note_refs)?;
            if notes.len() > 200 || name.is_empty() || name.chars().count() > 128 {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::ContextSetAttachments {
            set_id,
            target_kind,
            target_id,
            target_space,
            owner_id,
            ..
        } => {
            ContextSetId::parse(set_id)?;
            scope(target_kind, target_id, target_space, owner_id)?;
        }
        TargetRecord::ContextScopePins {
            owner_id,
            target_kind,
            target_id,
            target_space,
            ..
        } => scope(target_kind, target_id, target_space, owner_id)?,
        TargetRecord::ContextOrder {
            owner_id,
            target_kind,
            target_id,
            target_space,
            entry_kind,
            entry_ref,
            ..
        } => {
            scope(target_kind, target_id, target_space, owner_id)?;
            match entry_kind.as_str() {
                "set" => {
                    ContextSetId::parse(entry_ref)?;
                }
                "note" => {
                    canonical::<NoteRef>(entry_ref)?;
                }
                _ => return Err(invalid(ValidationReason::InvalidState)),
            }
        }
        TargetRecord::AgentSchedules {
            title,
            init_prompt,
            config_revision,
            cron_expr,
            timezone,
            approved_role,
            approved_skills,
            budgets,
            next_slot_utc_ms,
            deleted_at,
            revision,
            ..
        } => {
            let _: AbilityRef = parse(approved_role)?;
            skill_pins(approved_skills)?;
            let limits: RunLimits = parse(budgets)?;
            let prompt_invalid = if deleted_at.is_some() {
                init_prompt.len() > 32768
            } else {
                init_prompt.is_empty() || init_prompt.len() > 32768
            };
            if !limits.fits(RunLimits::HARD_CEILING)
                || title.is_empty()
                || title.len() > 512
                || title.chars().count() > 128
                || prompt_invalid
                || cron_expr.len() > 256
                || timezone.len() > 128
                || *revision < 0
                || *config_revision < 0
                || *config_revision > *revision
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            next_slot_utc_ms.map(schedule_timestamp).transpose()?;
            validate_stored_calendar(cron_expr, timezone, *next_slot_utc_ms, deleted_at.is_none())?;
        }
        TargetRecord::AgentScheduleRuns {
            slot_utc_ms,
            claim_request_hash,
            owner_auth_version,
            config_revision,
            admission_epoch,
            history_scope,
            expires_at,
            reserved_next_slot,
            approved_skills,
            keeper_log_id,
            keeper_project_folder_id,
            started_at,
            ..
        } => {
            schedule_timestamp(*slot_utc_ms)?;
            reserved_next_slot.map(schedule_timestamp).transpose()?;
            skill_pins(approved_skills)?;
            let _: HistoryScope = parse(history_scope)?;
            if history_scope.len() > 2048
                || claim_request_hash.len() != 32
                || *expires_at <= *started_at
                || expires_at.saturating_sub(*started_at)
                    > RunLimits::HARD_CEILING.timeout_ms as i64
                || *owner_auth_version < 0
                || *config_revision < 0
                || *admission_epoch < 0
                || reserved_next_slot.is_some_and(|slot| slot <= *slot_utc_ms)
                || (keeper_log_id.is_none() && keeper_project_folder_id.is_some())
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        _ => (),
    };
    Ok(())
}
