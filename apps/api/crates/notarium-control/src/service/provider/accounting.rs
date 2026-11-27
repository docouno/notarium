//! Durable intent and fixed UTC budget windows. No wire payload is persisted.
use super::{ProviderService, records::*};
use crate::{
    error::invalid,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    error::{BudgetKind, CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::*,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
#[cfg(test)]
#[path = "accounting_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BucketKey {
    pub kind: String,
    pub owner: String,
    pub start: i64,
    pub end: i64,
}
pub(super) struct BudgetLimit {
    pub kind: &'static str,
    pub owner: String,
    pub limits: ProviderLimits,
}
pub(super) fn window(now: i64) -> Result<(i64, i64), PortError> {
    if now < 0 {
        return Err(invalid(ValidationReason::InvalidTimestamp));
    }
    let start = now / 60_000 * 60_000;
    let end = start
        .checked_add(60_000)
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
    Ok((start, end))
}
fn limited(kind: BudgetKind, end: i64, now: i64) -> PortError {
    DomainError::RateLimited {
        retry_after_ms: (end.saturating_sub(now)).max(1) as u64,
        budget: kind,
    }
    .into()
}
pub(super) async fn existing(
    tx: &mut Transaction,
    principal: &str,
    scope: &str,
    intent: &CommandKey,
    hash: &[u8; 32],
) -> Result<(), PortError> {
    if let Some(row) = rows!(tx,ProviderCallLogRow,fetch_optional,"SELECT * FROM provider_call_log WHERE principal=$1 AND scope_id=$2 AND intent_key=$3","SELECT * FROM v1_control.provider_call_log WHERE principal=$1 AND scope_id=$2 AND intent_key=$3 FOR UPDATE";principal,scope,intent.as_str())?
    {
        if row.request_hash != hash {
            return Err(DomainError::IdempotencyKeyReused.into());
        }
        return Err(DomainError::ProviderCallAlreadyStarted {
            call: RequestId::parse(&row.call_id)?,
            state: state(&row.delivery_state)?,
        }
        .into());
    }
    Ok(())
}
pub(super) async fn existing_read(
    tx: &mut Transaction,
    principal: &str,
    scope: &str,
    intent: &CommandKey,
    hash: &[u8; 32],
) -> Result<(), PortError> {
    if let Some(row) = rows!(tx,ProviderCallLogRow,fetch_optional,"SELECT * FROM provider_call_log WHERE principal=$1 AND scope_id=$2 AND intent_key=$3","SELECT * FROM v1_control.provider_call_log WHERE principal=$1 AND scope_id=$2 AND intent_key=$3";principal,scope,intent.as_str())?
    {
        if row.request_hash != hash {
            return Err(DomainError::IdempotencyKeyReused.into());
        }
        return Err(DomainError::ProviderCallAlreadyStarted {
            call: RequestId::parse(&row.call_id)?,
            state: state(&row.delivery_state)?,
        }
        .into());
    }
    Ok(())
}
/// Called under the fresh principal/resource/Space authority transaction. All
/// bucket locks use a common lexical order across callers and service instances.
pub(super) async fn reserve(
    tx: &mut Transaction,
    mut row: ProviderCallLogRow,
    mut budgets: Vec<BudgetLimit>,
    now: i64,
) -> Result<ProviderCallLogRow, PortError> {
    let hash: &[u8; 32] = row
        .request_hash
        .as_slice()
        .try_into()
        .map_err(|_| invalid(ValidationReason::InvalidState))?;
    existing(
        tx,
        &row.principal,
        &row.scope_id,
        &CommandKey::parse(&row.intent_key)?,
        hash,
    )
    .await?;
    let (start, end) = window(now)?;
    if row.reserved_tokens < 0 || budgets.is_empty() || budgets.len() > 66 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let actual: std::collections::BTreeSet<_> = budgets
        .iter()
        .map(|budget| (budget.kind.to_owned(), budget.owner.clone()))
        .collect();
    if actual.len() != budgets.len() || actual != expected_buckets(&row)? {
        return Err(invalid(ValidationReason::InvalidState));
    }
    budgets.sort_by(|left, right| (left.kind, &left.owner).cmp(&(right.kind, &right.owner)));
    if budgets
        .windows(2)
        .any(|pair| pair[0].kind == pair[1].kind && pair[0].owner == pair[1].owner)
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let mut keys = Vec::new();
    for budget in budgets {
        limits(budget.limits)?;
        if !matches!(budget.kind, "resource" | "credential" | "space") {
            return Err(invalid(ValidationReason::InvalidState));
        }
        execute!(tx,"INSERT INTO provider_budget_buckets(budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact) VALUES($1,$2,$3,$4,0,0,0) ON CONFLICT(budget_kind,budget_owner,window_start_ms) DO NOTHING","INSERT INTO v1_control.provider_budget_buckets(budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact) VALUES($1,$2,$3,$4,0,0,0) ON CONFLICT(budget_kind,budget_owner,window_start_ms) DO NOTHING";budget.kind,&budget.owner,start,end)?;
        let current = rows!(tx,ProviderBudgetBucketsRow,fetch_one,"SELECT * FROM provider_budget_buckets WHERE budget_kind=$1 AND budget_owner=$2 AND window_start_ms=$3","SELECT * FROM v1_control.provider_budget_buckets WHERE budget_kind=$1 AND budget_owner=$2 AND window_start_ms=$3 FOR UPDATE";budget.kind,&budget.owner,start)?;
        if current.window_end_ms != end {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let rpm = current
            .rpm_used
            .checked_add(1)
            .ok_or_else(|| limited(BudgetKind::Requests, end, now))?;
        let reserved = current
            .tpm_reserved
            .checked_add(row.reserved_tokens)
            .ok_or_else(|| limited(BudgetKind::Tokens, end, now))?;
        let total = reserved
            .checked_add(current.tpm_exact)
            .ok_or_else(|| limited(BudgetKind::Tokens, end, now))?;
        if budget
            .limits
            .requests_per_minute
            .is_some_and(|limit| rpm > i64::from(limit))
        {
            return Err(limited(BudgetKind::Requests, end, now));
        }
        if budget
            .limits
            .tokens_per_minute
            .is_some_and(|limit| total as u64 > limit)
        {
            return Err(limited(BudgetKind::Tokens, end, now));
        }
        execute!(tx,"UPDATE provider_budget_buckets SET rpm_used=$1,tpm_reserved=$2 WHERE budget_kind=$3 AND budget_owner=$4 AND window_start_ms=$5","UPDATE v1_control.provider_budget_buckets SET rpm_used=$1,tpm_reserved=$2 WHERE budget_kind=$3 AND budget_owner=$4 AND window_start_ms=$5";rpm,reserved,budget.kind,&budget.owner,start)?;
        keys.push(BucketKey {
            kind: budget.kind.into(),
            owner: budget.owner,
            start,
            end,
        });
    }
    row.bucket_keys = json(&keys)?;
    row.created_at = now;
    row.delivery_state = "intent".into();
    row.dispatch_owner = None;
    row.outcome = None;
    row.usage_source = "unknown".into();
    row.input_tokens = None;
    row.output_tokens = None;
    row.diagnostic = None;
    row.settled_at = None;
    let record = TargetRecord::from(row.clone());
    record.validate()?;
    record.insert(tx).await?;
    Ok(row)
}
/// The sending transition and registry registration belong to the SAME final
/// authority transaction. No further SQL may be needed before closing the socket.
pub(super) async fn sending(
    tx: &mut Transaction,
    id: &RequestId,
    dispatcher: &RequestId,
) -> Result<(), PortError> {
    let changed = execute!(tx,"UPDATE provider_call_log SET delivery_state='sending',dispatch_owner=$1 WHERE call_id=$2 AND delivery_state='intent'","UPDATE v1_control.provider_call_log SET delivery_state='sending',dispatch_owner=$1 WHERE call_id=$2 AND delivery_state='intent'";dispatcher.as_str(),id.as_str())?;
    if changed != 1 {
        let row = call(tx, id).await?;
        return Err(DomainError::ProviderCallAlreadyStarted {
            call: id.clone(),
            state: state(&row.delivery_state)?,
        }
        .into());
    }
    Ok(())
}
pub(super) async fn call(
    tx: &mut Transaction,
    id: &RequestId,
) -> Result<ProviderCallLogRow, PortError> {
    rows!(tx,ProviderCallLogRow,fetch_optional,"SELECT * FROM provider_call_log WHERE call_id=$1","SELECT * FROM v1_control.provider_call_log WHERE call_id=$1 FOR UPDATE";id.as_str())?.ok_or(DomainError::ResourceNotFound.into())
}
pub(super) async fn call_read(
    tx: &mut Transaction,
    id: &RequestId,
) -> Result<ProviderCallLogRow, PortError> {
    rows!(tx,ProviderCallLogRow,fetch_optional,"SELECT * FROM provider_call_log WHERE call_id=$1","SELECT * FROM v1_control.provider_call_log WHERE call_id=$1";id.as_str())?.ok_or(DomainError::ResourceNotFound.into())
}
fn state(value: &str) -> Result<ProviderDeliveryState, PortError> {
    match value {
        "intent" => Ok(ProviderDeliveryState::Intent),
        "sending" => Ok(ProviderDeliveryState::Sending),
        "settled" => Ok(ProviderDeliveryState::Settled),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}
fn outcome(value: ProviderOutcome) -> &'static str {
    match value {
        ProviderOutcome::Completed => "completed",
        ProviderOutcome::NotSent => "not_sent",
        ProviderOutcome::Unknown => "unknown",
        ProviderOutcome::Failed => "failed",
        ProviderOutcome::Cancelled => "cancelled",
    }
}
fn diagnostic(value: ProviderErrorCode) -> &'static str {
    match value {
        ProviderErrorCode::Unavailable => "unavailable",
        ProviderErrorCode::UnsupportedModel => "unsupported_model",
        ProviderErrorCode::Protocol => "protocol",
        ProviderErrorCode::UpstreamAuthentication => "upstream_authentication",
        ProviderErrorCode::UpstreamRateLimit => "upstream_rate_limit",
        ProviderErrorCode::BudgetMismatch => "budget_mismatch",
    }
}
fn usage(row: &ProviderCallLogRow) -> Result<ProviderUsage, PortError> {
    match (
        row.usage_source.as_str(),
        row.input_tokens,
        row.output_tokens,
    ) {
        ("exact", Some(input), Some(output)) if input >= 0 && output >= 0 => {
            Ok(ProviderUsage::Exact {
                input_tokens: input as u64,
                output_tokens: output as u64,
            })
        }
        ("unknown" | "estimate", None, None) => Ok(ProviderUsage::Unknown),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}
pub(super) fn status(row: &ProviderCallLogRow) -> Result<ProviderCallStatus, PortError> {
    let outcome = row
        .outcome
        .as_deref()
        .map(|value| match value {
            "completed" => Ok(ProviderOutcome::Completed),
            "not_sent" => Ok(ProviderOutcome::NotSent),
            "unknown" => Ok(ProviderOutcome::Unknown),
            "failed" => Ok(ProviderOutcome::Failed),
            "cancelled" => Ok(ProviderOutcome::Cancelled),
            _ => Err(invalid(ValidationReason::InvalidState)),
        })
        .transpose()?;
    let diagnostic = row
        .diagnostic
        .as_deref()
        .map(|value| match value {
            "unavailable" => Ok(ProviderErrorCode::Unavailable),
            "unsupported_model" => Ok(ProviderErrorCode::UnsupportedModel),
            "protocol" => Ok(ProviderErrorCode::Protocol),
            "upstream_authentication" => Ok(ProviderErrorCode::UpstreamAuthentication),
            "upstream_rate_limit" => Ok(ProviderErrorCode::UpstreamRateLimit),
            "budget_mismatch" => Ok(ProviderErrorCode::BudgetMismatch),
            _ => Err(invalid(ValidationReason::InvalidState)),
        })
        .transpose()?;
    Ok(ProviderCallStatus {
        id: RequestId::parse(&row.call_id)?,
        resource: ProviderResourceId::parse(&row.resource_id)?,
        model: row
            .model_id
            .as_deref()
            .map(ModelProfileId::parse)
            .transpose()?,
        state: state(&row.delivery_state)?,
        outcome,
        usage: usage(row)?,
        reserved_tokens: row.reserved_tokens as u64,
        diagnostic,
        created_at_ms: row.created_at,
        settled_at_ms: row.settled_at,
    })
}
pub(super) async fn settle(
    tx: &mut Transaction,
    mut row: ProviderCallLogRow,
    actual: ProviderUsage,
    result: ProviderOutcome,
    mut error: Option<ProviderErrorCode>,
    now: i64,
) -> Result<ProviderCallStatus, PortError> {
    let late = row.delivery_state == "settled";
    if late {
        let previous = usage(&row)?;
        if actual == ProviderUsage::Unknown || previous == actual {
            return status(&row);
        }
        if previous != ProviderUsage::Unknown || row.outcome.as_deref() == Some("not_sent") {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    let total = match actual {
        ProviderUsage::Exact {
            input_tokens: input,
            output_tokens: output,
        } => Some(
            input
                .checked_add(output)
                .filter(|total| *total <= i64::MAX as u64)
                .ok_or_else(|| invalid(ValidationReason::InvalidState))? as i64,
        ),
        ProviderUsage::Unknown => None,
    };
    if total.is_some_and(|total| total > row.reserved_tokens) {
        error = Some(ProviderErrorCode::BudgetMismatch);
    }
    let not_sent = result == ProviderOutcome::NotSent;
    if not_sent && total.is_some() {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let mut keys: Vec<BucketKey> = parse(&row.bucket_keys)?;
    if keys.is_empty() || keys.len() > 66 {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let expected = expected_buckets(&row)?;
    let observed: std::collections::BTreeSet<_> = keys
        .iter()
        .map(|key| (key.kind.clone(), key.owner.clone()))
        .collect();
    let original = window(row.created_at)?;
    if expected != observed
        || observed.len() != keys.len()
        || keys.iter().any(|key| (key.start, key.end) != original)
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    keys.sort_by(|a, b| (&a.kind, &a.owner).cmp(&(&b.kind, &b.owner)));
    for key in keys {
        // Expired admission windows never credit the current window. Exact late
        // usage remains in the audit even if retention has removed the old bucket.
        if key.end <= now || (!not_sent && total.is_none()) {
            continue;
        }
        let mut bucket = rows!(tx,ProviderBudgetBucketsRow,fetch_one,"SELECT * FROM provider_budget_buckets WHERE budget_kind=$1 AND budget_owner=$2 AND window_start_ms=$3","SELECT * FROM v1_control.provider_budget_buckets WHERE budget_kind=$1 AND budget_owner=$2 AND window_start_ms=$3 FOR UPDATE";&key.kind,&key.owner,key.start)?;
        if bucket.window_end_ms != key.end {
            return Err(invalid(ValidationReason::InvalidState));
        }
        bucket.tpm_reserved = bucket
            .tpm_reserved
            .checked_sub(row.reserved_tokens)
            .filter(|value| *value >= 0)
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        if not_sent {
            bucket.rpm_used = bucket
                .rpm_used
                .checked_sub(1)
                .filter(|value| *value >= 0)
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        } else {
            bucket.tpm_exact = match bucket.tpm_exact.checked_add(total.unwrap_or(0)) {
                Some(total) => total,
                None => {
                    // The call audit below retains both exact counters. An
                    // unrepresentable aggregate closes admission for this window.
                    error = Some(ProviderErrorCode::BudgetMismatch);
                    i64::MAX
                }
            };
        }
        execute!(tx,"UPDATE provider_budget_buckets SET rpm_used=$1,tpm_reserved=$2,tpm_exact=$3 WHERE budget_kind=$4 AND budget_owner=$5 AND window_start_ms=$6","UPDATE v1_control.provider_budget_buckets SET rpm_used=$1,tpm_reserved=$2,tpm_exact=$3 WHERE budget_kind=$4 AND budget_owner=$5 AND window_start_ms=$6";bucket.rpm_used,bucket.tpm_reserved,bucket.tpm_exact,&key.kind,&key.owner,key.start)?;
    }
    row.delivery_state = "settled".into();
    if !late {
        row.outcome = Some(outcome(result).into());
        row.settled_at = Some(now);
    }
    if error.is_some() || !late {
        row.diagnostic = error.map(|value| diagnostic(value).into());
    }
    if let ProviderUsage::Exact {
        input_tokens: input,
        output_tokens: output,
    } = actual
    {
        row.usage_source = "exact".into();
        row.input_tokens = Some(input as i64);
        row.output_tokens = Some(output as i64);
    }
    execute!(tx,"UPDATE provider_call_log SET delivery_state='settled',outcome=$1,usage_source=$2,input_tokens=$3,output_tokens=$4,diagnostic=$5,settled_at=$6 WHERE call_id=$7","UPDATE v1_control.provider_call_log SET delivery_state='settled',outcome=$1,usage_source=$2,input_tokens=$3,output_tokens=$4,diagnostic=$5,settled_at=$6 WHERE call_id=$7";&row.outcome,&row.usage_source,row.input_tokens,row.output_tokens,&row.diagnostic,row.settled_at,&row.call_id)?;
    status(&row)
}
fn expected_buckets(
    row: &ProviderCallLogRow,
) -> Result<std::collections::BTreeSet<(String, String)>, PortError> {
    let spaces: Vec<SpaceId> = parse(&row.participating_spaces)?;
    let mut expected =
        std::collections::BTreeSet::from([("resource".to_owned(), row.resource_id.clone())]);
    if let Some(credential) = &row.credential_id {
        expected.insert(("credential".into(), credential.clone()));
    }
    for space in spaces {
        if !expected.insert(("space".into(), space.to_string())) {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    Ok(expected)
}
impl ProviderService {
    /// The network/registry/metadata leases must have been released first. This
    /// independent finite budget lets caller cancellation retain a durable audit.
    pub(super) async fn finalize(
        &self,
        id: &RequestId,
        dispatcher: Option<&RequestId>,
        actual: ProviderUsage,
        result: ProviderOutcome,
        error: Option<ProviderErrorCode>,
    ) -> Result<ProviderCallStatus, PortError> {
        let budget = OperationBudget::new(CallBudget {
            request: id.clone(),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(5),
        });
        let mut tx = self.control.store.write(budget.clone()).await?;
        let status = budget
            .run(
                async {
                    let row = call(tx.inner_mut(), id).await?;
                    if row.dispatch_owner.is_some()
                        && row.dispatch_owner.as_deref() != dispatcher.map(RequestId::as_str)
                    {
                        return Err(DomainError::AccessDenied.into());
                    }
                    settle(
                        tx.inner_mut(),
                        row,
                        actual,
                        result,
                        error,
                        self.control.clock.now_ms()?,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run_commit(tx.commit()).await?;
        Ok(status)
    }
    pub async fn inspect_call(
        &self,
        ctx: AccountContext,
        id: RequestId,
    ) -> Result<ProviderCallStatus, PortError> {
        if matches!(
            ctx.auth().kind(),
            notarium_core::auth::PrincipalKind::AgentRun(_)
                | notarium_core::auth::PrincipalKind::Keeper(_)
        ) {
            return Err(DomainError::AccessDenied.into());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .control
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        if let Err(err) = super::super::authority::require_unpinned_human(&auth).and_then(|()| {
            if auth.is_space_narrowed() {
                Err(DomainError::AccessDenied.into())
            } else {
                Ok(())
            }
        }) {
            let _ = budget.run(tx.rollback(), CommitEffect::NotCommitted).await;
            return Err(err);
        }
        let status = budget
            .run(
                async {
                    let row = call_read(tx.inner_mut(), &id).await?;
                    owned(auth.principal().as_str(), &row.owner_id)?;
                    status(&row)
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(status)
    }
}
