//! Typed account-state payloads have the same import and service invariants.
use super::target::{AbilityTrailPayload, TargetRecord};
use super::values::{closed_json as parse, schedule_timestamp};
use crate::error::invalid;
use notarium_core::{
    error::{PortError, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope, NoteRef},
    ports::{control::*, telemetry::*},
};
use serde::{Serialize, de::DeserializeOwned};
use std::str::FromStr;
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
        TargetRecord::AgentEpisodes(row) => {
            if let Some(parent) = &row.parent_id {
                EpisodeId::parse(parent)?;
            }
            if let Some(role) = &row.active_role {
                parse::<AbilityRef>(role)?;
            }
            if row
                .name
                .as_ref()
                .is_some_and(|name| name.is_empty() || name.chars().count() > 128)
            {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::AbilityAvailability(row) => {
            canonical::<AbilityPlacement>(&row.placement)?;
        }
        TargetRecord::AbilityProjectBindings(row) => {
            canonical::<AbilityPlacement>(&row.placement)?;
        }
        TargetRecord::AbilityPreferences(row) => {
            canonical::<AbilityPlacement>(&row.placement)?;
        }
        TargetRecord::AbilityPlacementTrail(row) => {
            let source: AbilityPlacement = canonical(&row.source_placement)?;
            let destination: AbilityPlacement = canonical(&row.destination_placement)?;
            let trail: AbilityTrailPayload = parse(&row.manifest_ref)?;
            if trail.source.placement != source
                || trail.source.id.as_str() != row.ability_id
                || trail.destination.placement != destination
                || trail.destination.id.as_str() != row.destination_id
                || trail.source.identity() == trail.destination.identity()
            {
                return Err(invalid(ValidationReason::ScopeMismatch));
            }
        }
        TargetRecord::AgentTelemetryConfig(row) => {
            if !(1..=3650).contains(&row.compact_retention_days)
                || !(1..=row.compact_retention_days).contains(&row.detailed_retention_days)
            {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::AgentCalls(row) => {
            RequestId::parse(&row.call_id)?;
            RequestId::parse(&row.request_id)?;
            PrincipalId::parse(&row.principal)?;
            if let Some(agent) = &row.agent {
                AgentRunId::parse(agent)?;
            }
            parse::<AgentOperation>(&serde_json::to_string(&row.tool).expect("string"))?;
            parse::<AgentTransport>(&serde_json::to_string(&row.transport).expect("string"))?;
            parse::<AgentEffect>(&serde_json::to_string(&row.effect).expect("string"))?;
            let summary: Option<ContentDigest> = parse(&row.summaries)?;
            let outcome: Option<AgentOutcome> = row
                .outcome
                .as_ref()
                .map(|s| parse(&serde_json::to_string(s).expect("string")))
                .transpose()?;
            if let Some(reason) = &row.reason {
                parse::<AgentFailure>(&serde_json::to_string(reason).expect("string"))?;
            }
            if row.domain != "control"
                || row.redacted != 1
                || row.projection_version != 1
                || row.principal != row.owner_id
                || row.fingerprint.len() != 32
                || row.finished_at.is_some() != outcome.is_some()
                || row.finished_at.is_some() != row.duration_ms.is_some()
                || row.finished_at.is_some() != row.output_bytes.is_some()
                || row.finished_at.is_some() != summary.is_some()
                || row.finished_at.is_some_and(|at| {
                    at < row.started_at || at.checked_sub(row.started_at) != row.duration_ms
                })
                || (outcome == Some(AgentOutcome::Succeeded) && row.reason.is_some())
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        TargetRecord::AgentCallDetails(row) => {
            RequestId::parse(&row.call_id)?;
            let value: AgentCallDetail = parse(&row.payload)?;
            if value.resources.len() > 200
                || value.counters.len() > 200
                || value.steps.len() > 200
                || row.expires_at <= row.created_at
            {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::AgentRetrievals(row) => {
            RequestId::parse(&row.retrieval_id)?;
            PrincipalId::parse(&row.principal)?;
            if let Some(agent) = &row.agent {
                AgentRunId::parse(agent)?;
            }
            if let Some(call) = &row.call_id {
                RequestId::parse(call)?;
            }
            parse::<RetrievalKind>(&row.query_summary)?;
            parse::<ContentDigest>(&row.filters)?;
            let hits: Vec<NoteRef> = parse(&row.hit_refs)?;
            if row.tool != "search"
                || row.principal != row.owner_id
                || hits.len() > 200
                || row.result_count < 0
                || hits.len() as i64 > row.result_count
                || row.top_score.is_some_and(|score| !score.is_finite())
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        TargetRecord::Favorites(row) => match row.entity_kind.as_str() {
            "note" => {
                NoteId::parse(&row.entity_id)?;
            }
            "folder" => {
                FolderId::parse(&row.entity_id)?;
            }
            _ => return Err(invalid(ValidationReason::InvalidState)),
        },
        TargetRecord::ContextSets(row) => {
            ContextSetId::parse(&row.set_id)?;
            let notes: Vec<NoteRef> = parse(&row.note_refs)?;
            if notes.len() > 200 || row.name.is_empty() || row.name.chars().count() > 128 {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        TargetRecord::ContextSetAttachments(row) => {
            ContextSetId::parse(&row.set_id)?;
            scope(
                &row.target_kind,
                &row.target_id,
                &row.target_space,
                &row.owner_id,
            )?;
        }
        TargetRecord::ContextScopePins(row) => scope(
            &row.target_kind,
            &row.target_id,
            &row.target_space,
            &row.owner_id,
        )?,
        TargetRecord::ContextOrder(row) => {
            scope(
                &row.target_kind,
                &row.target_id,
                &row.target_space,
                &row.owner_id,
            )?;
            match row.entry_kind.as_str() {
                "set" => {
                    ContextSetId::parse(&row.entry_ref)?;
                }
                "note" => {
                    canonical::<NoteRef>(&row.entry_ref)?;
                }
                _ => return Err(invalid(ValidationReason::InvalidState)),
            }
        }
        TargetRecord::AgentSchedules(row) => {
            schedule_timestamp(row.next_slot_utc_ms)?;
            let role: AbilityRef = parse(&row.approved_role)?;
            let _ = role;
            let limits: RunLimits = parse(&row.budgets)?;
            if !limits.fits(RunLimits::HARD_CEILING)
                || row.title.is_empty()
                || row.title.len() > 512
                || row.title.chars().count() > 128
                || row.init_prompt.is_empty()
                || row.init_prompt.len() > 32768
                || row.cron_expr.len() > 256
                || row.timezone.len() > 128
                || row.revision < 0
                || row.config_revision < 0
                || row.config_revision > row.revision
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            let cron = cron::Schedule::from_str(&row.cron_expr)
                .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
            let zone = chrono_tz::Tz::from_str(&row.timezone)
                .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
            let date = chrono::DateTime::from_timestamp_millis(row.next_slot_utc_ms)
                .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
            if row.next_slot_utc_ms % 1000 != 0 || !cron.includes(date.with_timezone(&zone)) {
                return Err(invalid(ValidationReason::InvalidTimestamp));
            }
        }
        TargetRecord::AgentScheduleRuns(row) => {
            schedule_timestamp(row.slot_utc_ms)?;
            schedule_timestamp(row.reserved_next_slot)?;
            let _: HistoryScope = parse(&row.history_scope)?;
            if row.history_scope.len() > 2048
                || row.claim_request_hash.len() != 32
                || row.expires_at <= row.started_at
                || row.expires_at.saturating_sub(row.started_at)
                    > RunLimits::HARD_CEILING.timeout_ms as i64
                || row.owner_auth_version < 0
                || row.config_revision < 0
                || row.admission_epoch < 0
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
        }
        _ => (),
    };
    Ok(())
}
