use crate::{
    error::invalid,
    store::{
        Transaction,
        statements::rows,
        target::{ControlCommandsRow, TargetRecord},
    },
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::*,
    receipt::AccountCommandIdentity,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedResult<T> {
    pub value: T,
    pub events: Vec<RequestId>,
}
pub(super) struct Command {
    pub identity: AccountCommandIdentity,
    pub operation: &'static str,
    hash: Vec<u8>,
}
impl Command {
    /// The persisted fingerprint binds both the supplied digest and the actual
    /// normalized non-secret payload. A dishonest digest cannot hide key reuse.
    pub fn new(
        identity: AccountCommandIdentity,
        operation: &'static str,
        payload: impl Serialize,
    ) -> Result<Self, PortError> {
        let bytes = serde_json::to_vec(&(1, operation, identity.hash, identity.expected, payload))
            .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
        if bytes.len() > 65536 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(Self {
            identity,
            operation,
            hash: blake3::hash(&bytes).as_bytes().to_vec(),
        })
    }
    pub fn require(&self, actor: &PrincipalId, owner: &PrincipalId) -> Result<(), PortError> {
        if &self.identity.actor != actor || &self.identity.owner != owner {
            return Err(DomainError::AccessDenied.into());
        }
        Ok(())
    }
    pub async fn replay<T: serde::de::DeserializeOwned>(
        &self,
        tx: &mut Transaction,
    ) -> Result<Option<(ControlRevision, SavedResult<T>)>, PortError> {
        let row = rows!(tx,ControlCommandsRow,fetch_optional,
            "SELECT * FROM control_commands WHERE owner=$1 AND actor=$2 AND command_key=$3",
            "SELECT * FROM v1_control.control_commands WHERE owner=$1 AND actor=$2 AND command_key=$3";self.identity.owner.as_str(),self.identity.actor.as_str(),self.identity.key.as_str())?;
        row.map(|row| {
            if row.request_hash != self.hash
                || row.target != self.operation
                || row.expected != self.identity.expected.get() as i64
            {
                return Err(DomainError::IdempotencyKeyReused.into());
            }
            let result = serde_json::from_str(
                row.safe_result
                    .as_deref()
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
            )
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
            let revision = ControlRevision::new(
                row.result_revision
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))? as u64,
            )?;
            Ok((revision, result))
        })
        .transpose()
    }
    pub async fn save<T: Serialize>(
        &self,
        tx: &mut Transaction,
        revision: ControlRevision,
        result: &SavedResult<T>,
        now: i64,
    ) -> Result<(), PortError> {
        let value =
            serde_json::to_string(result).map_err(|_| invalid(ValidationReason::InvalidState))?;
        if value.len() > 65536 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let record = TargetRecord::from(ControlCommandsRow {
            owner: self.identity.owner.to_string(),
            actor: self.identity.actor.to_string(),
            command_key: self.identity.key.to_string(),
            request_hash: self.hash.clone(),
            target: self.operation.into(),
            expected: self.identity.expected.get() as i64,
            result_revision: Some(revision.get() as i64),
            state: "committed".into(),
            safe_result: Some(value),
            expires_at: now
                .checked_add(30 * 24 * 60 * 60 * 1000)
                .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?,
        });
        record.validate()?;
        record.insert(tx).await
    }
}
