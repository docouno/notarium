use crate::{
    error::invalid,
    outbound::{OutboundScope, ProviderWire},
    store::{Transaction, statements::rows, target::*},
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::*,
    ports::*,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::BTreeMap;

pub(super) fn json(value: &impl Serialize) -> Result<String, PortError> {
    serde_json::to_string(value).map_err(|_| invalid(ValidationReason::InvalidQuery))
}
pub(super) fn parse<T: DeserializeOwned>(value: &str) -> Result<T, PortError> {
    serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidState))
}
pub(super) fn name(value: &str) -> Result<(), PortError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}
pub(super) fn limits(value: ProviderLimits) -> Result<(), PortError> {
    if value.requests_per_minute == Some(0)
        || value
            .tokens_per_minute
            .is_some_and(|n| n == 0 || n > i64::MAX as u64)
    {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok(())
}
pub(super) fn stored_limits(
    rpm: Option<i64>,
    tpm: Option<i64>,
) -> Result<ProviderLimits, PortError> {
    let result = ProviderLimits {
        requests_per_minute: rpm
            .map(u32::try_from)
            .transpose()
            .map_err(|_| invalid(ValidationReason::InvalidState))?,
        tokens_per_minute: tpm
            .map(u64::try_from)
            .transpose()
            .map_err(|_| invalid(ValidationReason::InvalidState))?,
    };
    limits(result)?;
    Ok(result)
}
pub(super) fn revision(current: i64, expected: ControlRevision) -> Result<(), PortError> {
    let current = ControlRevision::new(
        current
            .try_into()
            .map_err(|_| invalid(ValidationReason::InvalidState))?,
    )?;
    if current != expected {
        return Err(DomainError::ControlRevisionConflict { current }.into());
    }
    Ok(())
}
pub(super) fn owned(owner: &str, actual: &str) -> Result<(), PortError> {
    if owner != actual {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}
pub(super) fn header(value: &str) -> Result<String, PortError> {
    let name = reqwest::header::HeaderName::from_bytes(value.as_bytes())
        .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
    let name = name.as_str();
    if name.len() > 128
        || matches!(
            name,
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "proxy-authorization"
                | "proxy-connection"
                | "proxy-authenticate"
                | "keep-alive"
                | "te"
                | "trailer"
                | "upgrade"
                | "content-type"
                | "content-encoding"
                | "accept"
                | "accept-encoding"
                | "user-agent"
                | "expect"
                | "range"
        )
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(name.into())
}
pub(super) fn injection(value: &mut CredentialInjection) -> Result<(), PortError> {
    value.header = header(&value.header)?;
    if value.prefix.len() > 128 || value.prefix.bytes().any(|b| !(32..=126).contains(&b)) {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}
pub(super) fn secret(value: &str) -> Result<(), PortError> {
    if value.is_empty()
        || value.len() > 8192
        || reqwest::header::HeaderValue::from_str(value).is_err()
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}
pub(super) async fn credential(
    tx: &mut Transaction,
    id: &str,
) -> Result<CredentialsRow, PortError> {
    rows!(tx,CredentialsRow,fetch_optional,"SELECT * FROM credentials WHERE id=$1 AND kind='provider-header-v1'","SELECT * FROM v1_control.credentials WHERE id=$1 AND kind='provider-header-v1' FOR UPDATE";id)?.ok_or(DomainError::ResourceNotFound.into())
}
pub(super) async fn resource(
    tx: &mut Transaction,
    id: &str,
) -> Result<ProviderResourcesRow, PortError> {
    rows!(tx,ProviderResourcesRow,fetch_optional,"SELECT * FROM provider_resources WHERE id=$1","SELECT * FROM v1_control.provider_resources WHERE id=$1 FOR UPDATE";id)?.ok_or(DomainError::ResourceNotFound.into())
}
pub(super) async fn model(
    tx: &mut Transaction,
    resource: &str,
    id: &str,
) -> Result<ProviderModelsRow, PortError> {
    rows!(tx,ProviderModelsRow,fetch_optional,"SELECT * FROM provider_models WHERE resource_id=$1 AND model_id=$2","SELECT * FROM v1_control.provider_models WHERE resource_id=$1 AND model_id=$2 FOR UPDATE";resource,id)?.ok_or(DomainError::ResourceNotFound.into())
}
pub(super) fn credential_info(row: &CredentialsRow) -> Result<ProviderCredentialInfo, PortError> {
    Ok(ProviderCredentialInfo {
        id: CredentialId::parse(&row.id)?,
        name: row.name.clone(),
        injection: parse(&row.injection)?,
        has_secret: !row.secret.is_empty(),
        limits: stored_limits(row.rpm, row.tpm)?,
        disabled: row.disabled_at.is_some(),
        consent_epoch: row.consent_epoch as u64,
        revision: ControlRevision::new(row.revision as u64)?,
    })
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Timeouts {
    pub version: u8,
    pub total_ms: u32,
}
pub(super) fn timeout(row: &ProviderResourcesRow) -> Result<u32, PortError> {
    let value: Timeouts = parse(&row.timeouts)?;
    if value.version != 1 || !(1..=120_000).contains(&value.total_ms) {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(value.total_ms)
}
pub(super) fn wire(value: &str) -> Result<ProviderWireKind, PortError> {
    match value {
        "openai-compatible" => Ok(ProviderWireKind::OpenaiCompatible),
        "ollama" => Ok(ProviderWireKind::Ollama),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}
pub(super) fn wire_name(value: ProviderWireKind) -> &'static str {
    match value {
        ProviderWireKind::OpenaiCompatible => "openai-compatible",
        ProviderWireKind::Ollama => "ollama",
    }
}
pub(super) fn scope(
    id: ProviderResourceId,
    wire: ProviderWireKind,
    runtime_epoch: u64,
    credential_epoch: Option<u64>,
) -> OutboundScope {
    OutboundScope::Provider {
        resource: id,
        runtime_epoch,
        credential_epoch,
        wire: match wire {
            ProviderWireKind::OpenaiCompatible => ProviderWire::OpenAi,
            ProviderWireKind::Ollama => ProviderWire::Ollama,
        },
    }
}
pub(super) fn resource_info(row: &ProviderResourcesRow) -> Result<ProviderResourceInfo, PortError> {
    let headers: BTreeMap<String, String> = parse(&row.headers)?;
    Ok(ProviderResourceInfo {
        id: ProviderResourceId::parse(&row.id)?,
        owner: PrincipalId::parse(&row.owner_id)?,
        name: row.name.clone(),
        wire: wire(&row.wire)?,
        base_url: row.base_url.clone(),
        credential: row
            .credential_id
            .as_deref()
            .map(CredentialId::parse)
            .transpose()?,
        secret_headers: headers.into_keys().collect(),
        limits: stored_limits(row.rpm, row.tpm)?,
        timeout_ms: timeout(row)?,
        disabled: row.disabled_at.is_some(),
        consent_epoch: row.consent_epoch as u64,
        revision: ControlRevision::new(row.revision as u64)?,
        default_model: row
            .default_model
            .as_deref()
            .map(ModelProfileId::parse)
            .transpose()?,
    })
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Capabilities {
    pub version: u8,
    pub tools: bool,
}
pub(super) fn model_info(row: &ProviderModelsRow) -> Result<ProviderModelInfo, PortError> {
    let capabilities: Capabilities = parse(&row.capabilities)?;
    if capabilities.version != 1 || row.tokenizer_profile != "conservative-model-cap-v1" {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let kind = match (row.kind.as_str(), row.dimension) {
        ("completion", None) => ProviderModelKind::Completion,
        ("embedding", Some(dimension)) => ProviderModelKind::Embedding {
            dimension: dimension
                .try_into()
                .map_err(|_| invalid(ValidationReason::InvalidState))?,
        },
        _ => return Err(invalid(ValidationReason::InvalidState)),
    };
    let model = ProviderModelSpec {
        id: ModelProfileId::parse(&row.model_id)?,
        wire_name: row.wire_model_name.clone(),
        kind,
        accounting: TokenAccountingProfile::ConservativeModelCapV1,
        max_input_tokens: row
            .max_input
            .try_into()
            .map_err(|_| invalid(ValidationReason::InvalidState))?,
        max_output_tokens: row
            .max_output
            .try_into()
            .map_err(|_| invalid(ValidationReason::InvalidState))?,
        tools: capabilities.tools,
    };
    model_spec(&model)?;
    Ok(ProviderModelInfo {
        resource: ProviderResourceId::parse(&row.resource_id)?,
        model,
        revision: ControlRevision::new(row.revision as u64)?,
    })
}
pub(super) fn model_spec(value: &ProviderModelSpec) -> Result<(), PortError> {
    name(&value.wire_name)?;
    if value.max_input_tokens == 0
        || value.max_input_tokens > 16_777_216
        || value.max_output_tokens > 1_048_576
    {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    match value.kind {
        ProviderModelKind::Completion if value.max_output_tokens > 0 => Ok(()),
        ProviderModelKind::Embedding { dimension }
            if (1..=65_536).contains(&dimension)
                && !value.tools
                && value.max_output_tokens == 0 =>
        {
            Ok(())
        }
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

pub(super) async fn attachment(
    tx: &mut Transaction,
    id: &str,
) -> Result<ProviderAttachmentsRow, PortError> {
    rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE id=$1","SELECT * FROM v1_control.provider_attachments WHERE id=$1 FOR UPDATE";id)?.ok_or(DomainError::ResourceNotFound.into())
}
pub(super) fn attachment_target(
    row: &ProviderAttachmentsRow,
) -> Result<ProviderAttachmentTarget, PortError> {
    let space = SpaceId::parse(&row.target_space)?;
    match row.target_kind.as_str() {
        "personal" => Ok(ProviderAttachmentTarget::Personal {
            owner: PrincipalId::parse(
                row.target_owner
                    .as_deref()
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
            )?,
            space,
        }),
        "space" => Ok(ProviderAttachmentTarget::Space(space)),
        "project" => Ok(ProviderAttachmentTarget::Project(
            notarium_core::model::FolderRef {
                space_id: space,
                folder_id: FolderId::parse(
                    row.target_project
                        .as_deref()
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
                )?,
            },
        )),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}
pub(super) fn target_space(target: &ProviderAttachmentTarget) -> &SpaceId {
    match target {
        ProviderAttachmentTarget::Personal { space, .. }
        | ProviderAttachmentTarget::Space(space) => space,
        ProviderAttachmentTarget::Project(project) => &project.space_id,
    }
}
pub(super) fn attachment_info(
    row: &ProviderAttachmentsRow,
) -> Result<ProviderAttachmentInfo, PortError> {
    Ok(ProviderAttachmentInfo {
        id: RequestId::parse(&row.id)?,
        resource: ProviderResourceId::parse(&row.resource_id)?,
        target: attachment_target(row)?,
        disclosure: parse(&row.disclosure)?,
        state: match row.state.as_str() {
            "pending" => ProviderAttachmentState::Pending,
            "approved" => ProviderAttachmentState::Approved,
            "revoked" => ProviderAttachmentState::Revoked,
            _ => return Err(invalid(ValidationReason::InvalidState)),
        },
        resource_consent_epoch: row.resource_epoch as u64,
        credential_consent_epoch: row.credential_epoch.map(|epoch| epoch as u64),
        expires_at_ms: row.expires_at,
        revision: ControlRevision::new(row.revision as u64)?,
    })
}
