//! Bounded, content-free audit persistence. Transport logging is a separate owner.
mod calls;
pub(crate) mod cleanup;
mod ports;
mod queries;
use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
    metadata::{digest, hidden},
};
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
    auth::PrincipalKind,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
const DAY: i64 = 86_400_000;
const MIN_COMPACT_DAYS: u16 = 1;
pub(super) const MIN_COMPACT_MS: i64 = MIN_COMPACT_DAYS as i64 * DAY;
fn json(value: &impl Serialize) -> Result<String, PortError> {
    serde_json::to_string(value).map_err(|_| invalid(ValidationReason::InvalidState))
}
fn parse<T: DeserializeOwned>(value: &str) -> Result<T, PortError> {
    serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidState))
}
fn label(value: &impl Serialize) -> Result<String, PortError> {
    parse(&json(value)?)
}
fn hash(value: &impl Serialize) -> Result<ContentDigest, PortError> {
    Ok(ContentDigest::from_bytes(
        *blake3::hash(json(value)?.as_bytes()).as_bytes(),
    ))
}
fn signed(value: u64) -> Result<i64, PortError> {
    i64::try_from(value).map_err(|_| invalid(ValidationReason::InvalidLimit))
}
fn detail(value: &AgentCallDetail) -> Result<String, PortError> {
    let result = json(value)?;
    if value.resources.len() > 200
        || value.counters.len() > 200
        || value.steps.len() > 200
        || result.len() > 65536
    {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok(result)
}
fn settings(row: &AgentTelemetryConfigRow) -> Result<TelemetrySettings, PortError> {
    Ok(TelemetrySettings {
        detailed_enabled: row.detailed_enabled == 1,
        compact_retention_days: row.compact_retention_days as u16,
        detailed_retention_days: row.detailed_retention_days as u16,
        revision: ControlRevision::new(row.version as u64)?,
    })
}
async fn configuration(
    tx: &mut Transaction,
    lock: bool,
) -> Result<AgentTelemetryConfigRow, PortError> {
    let row = if lock {
        rows!(
            tx,
            AgentTelemetryConfigRow,
            fetch_optional,
            "SELECT * FROM agent_telemetry_config WHERE singleton=1",
            "SELECT * FROM v1_control.agent_telemetry_config WHERE singleton=1 FOR UPDATE";
        )?
    } else {
        rows!(
            tx,
            AgentTelemetryConfigRow,
            fetch_optional,
            "SELECT * FROM agent_telemetry_config WHERE singleton=1",
            "SELECT * FROM v1_control.agent_telemetry_config WHERE singleton=1 FOR SHARE";
        )?
    };
    Ok(row.unwrap_or(AgentTelemetryConfigRow {
        singleton: 1,
        detailed_enabled: 0,
        compact_retention_days: 90,
        detailed_retention_days: 30,
        version: 0,
        updated_at: 0,
    }))
}
async fn configuration_read(tx: &mut Transaction) -> Result<AgentTelemetryConfigRow, PortError> {
    let row = rows!(
        tx,
        AgentTelemetryConfigRow,
        fetch_optional,
        "SELECT * FROM agent_telemetry_config WHERE singleton=1",
        "SELECT * FROM v1_control.agent_telemetry_config WHERE singleton=1";
    )?;
    Ok(row.unwrap_or(AgentTelemetryConfigRow {
        singleton: 1,
        detailed_enabled: 0,
        compact_retention_days: 90,
        detailed_retention_days: 30,
        version: 0,
        updated_at: 0,
    }))
}
impl ControlService {
    pub async fn telemetry_settings(
        &self,
        ctx: AccountContext,
    ) -> Result<TelemetrySettings, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.read(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let (owner, _) = self
                        .manager_read(tx.inner_mut(), ctx.auth(), ctx.auth().principal())
                        .await?;
                    if owner.is_admin != 1 {
                        return Err(access_denied());
                    }
                    settings(&configuration_read(tx.inner_mut()).await?)
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        Ok(result)
    }
    pub async fn update_telemetry_settings(
        &self,
        ctx: AccountContext,
        request: AccountMutation<TelemetrySettings>,
    ) -> Result<ControlCommit<TelemetrySettings>, PortError> {
        ctx.auth().authorize_human_management()?;
        let input = request.input;
        if input.compact_retention_days < MIN_COMPACT_DAYS
            || input.compact_retention_days > 3650
            || input.detailed_retention_days == 0
            || input.detailed_retention_days > input.compact_retention_days
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let command = Command::new(request.identity, "telemetry-settings", &input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision,saved)=budget.run(async{
            let (owner,_)=self.manager(tx.inner_mut(),ctx.auth(),ctx.auth().principal()).await?;if owner.is_admin!=1{return Err(access_denied());}
            if let Some(replay)=command.replay::<TelemetrySettings>(tx.inner_mut()).await?{return Ok(replay);}
            expect_revision(&owner,command.identity.expected)?;
            // Materialize the default before locking so two administrators
            // updating an empty table have the same CAS serialization point.
            execute!(tx.inner_mut(),"INSERT INTO agent_telemetry_config(singleton,version,updated_at) VALUES(1,0,0) ON CONFLICT(singleton) DO NOTHING","INSERT INTO v1_control.agent_telemetry_config(singleton,version,updated_at) VALUES(1,0,0) ON CONFLICT(singleton) DO NOTHING";)?;
            let current=configuration(tx.inner_mut(),true).await?;
            if current.version as u64!=input.revision.get(){return Err(DomainError::ControlRevisionConflict{current:ControlRevision::new(current.version as u64)?}.into());}
            let version=next(current.version)?;let now=self.clock.now_ms()?;
            execute!(tx.inner_mut(),"UPDATE agent_telemetry_config SET detailed_enabled=$1,compact_retention_days=$2,detailed_retention_days=$3,version=$4,updated_at=$5 WHERE singleton=1","UPDATE v1_control.agent_telemetry_config SET detailed_enabled=$1,compact_retention_days=$2,detailed_retention_days=$3,version=$4,updated_at=$5 WHERE singleton=1";i64::from(input.detailed_enabled),i64::from(input.compact_retention_days),i64::from(input.detailed_retention_days),version,now)?;
            let revision=next(owner.revision)?;execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&owner.user_id)?;
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult{value:TelemetrySettings{revision:ControlRevision::new(version as u64)?,..input},events:vec![]};command.save(tx.inner_mut(),revision,&saved,now).await?;Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
}
