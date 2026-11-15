//! Versioned target rows used by offline migration and backup. No source-version parsing.
use crate::{error::database, store::Transaction};
use notarium_core::error::PortError;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
pub const TARGET_SCHEMA_VERSION: u32 = 1;
fn text_bytes(value: &str) -> Result<usize, PortError> {
    if value.len() > 1048576 {
        return Err(crate::error::invalid(
            notarium_core::error::ValidationReason::InvalidLimit,
        ));
    }
    if value.contains('\0') {
        return Err(crate::error::invalid(
            notarium_core::error::ValidationReason::DisallowedCodePoint,
        ));
    }
    Ok(value.len())
}
pub(crate) fn validate_index(bytes: usize) -> Result<(), PortError> {
    if bytes > 2048 {
        return Err(crate::error::invalid(
            notarium_core::error::ValidationReason::InvalidLimit,
        ));
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct V1StorageEpochRow {
    pub singleton: i64,
    pub epoch_version: i64,
    pub state: String,
    pub installation_id: String,
    pub receipt_sha256: Option<Vec<u8>>,
    pub receipt_json: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct UsersRow {
    pub user_id: String,
    pub username: String,
    pub email: Option<String>,
    pub display_name: String,
    pub password_hash: Option<String>,
    pub is_admin: i64,
    pub disabled_at: Option<i64>,
    pub personal_space_id: Option<String>,
    pub revision: i64,
    pub auth_version: i64,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct UserOidcIdentitiesRow {
    pub issuer: String,
    pub subject: String,
    pub user_id: String,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct SpaceAdmissionRow {
    pub space_id: String,
    pub state: String,
    pub admission_epoch: i64,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct SpaceMembersRow {
    pub space_id: String,
    pub user_id: String,
    pub role: String,
    pub admission: String,
    pub revision: i64,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct SessionsRow {
    pub session_id: String,
    pub token_hash: Vec<u8>,
    pub user_id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_used_at: i64,
    pub revoked_at: Option<i64>,
    pub auth_version: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OneTimeTokensRow {
    pub token_hash: Vec<u8>,
    pub user_id: String,
    pub purpose: String,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct PatsRow {
    pub token_id: String,
    pub secret_hash: Vec<u8>,
    pub user_id: String,
    pub name: String,
    pub scope: String,
    pub selected_spaces: Option<String>,
    pub expires_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OauthClientsRow {
    pub client_id: String,
    pub kind: String,
    pub redirect_uris: String,
    pub client_name: String,
    pub metadata_uri: Option<String>,
    pub metadata_digest: Option<Vec<u8>>,
    pub cache_expires_at: Option<i64>,
    pub activated_at: Option<i64>,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OauthGrantsRow {
    pub grant_id: String,
    pub user_id: String,
    pub client_id: String,
    pub resource_uri: String,
    pub scope: String,
    pub selected_spaces: Option<String>,
    pub revoked_at: Option<i64>,
    pub revision: i64,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OauthAuthCodesRow {
    pub code_hash: Vec<u8>,
    pub grant_id: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub resource_uri: String,
    pub code_challenge: String,
    pub method: String,
    pub offline_access: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OauthRefreshFamiliesRow {
    pub family_id: String,
    pub grant_id: String,
    pub revoked_at: Option<i64>,
    pub reason_code: Option<String>,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OauthRefreshTokensRow {
    pub token_id: String,
    pub token_hash: Vec<u8>,
    pub family_id: String,
    pub client_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub rotated_to: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OauthAccessTokensRow {
    pub token_id: String,
    pub token_hash: Vec<u8>,
    pub grant_id: String,
    pub family_id: Option<String>,
    pub refresh_id: Option<String>,
    pub resource_uri: String,
    pub scope: String,
    pub selected_spaces: Option<String>,
    pub issued_at: i64,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    pub last_used_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct SecretKeyringRow {
    pub key_id: String,
    pub key_hash: String,
    pub generation: i64,
    pub state: String,
    pub canary: String,
    pub created_at: i64,
    pub retired_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OidcTransactionsRow {
    pub transaction_id: String,
    pub state_hash: Vec<u8>,
    pub nonce_hash: Vec<u8>,
    pub flow_context_hash: Vec<u8>,
    pub key_id: String,
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub purpose: String,
    pub bound_user: Option<String>,
    pub browser_binding_hash: Vec<u8>,
    pub expires_at: i64,
    pub consumed_at: Option<i64>,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct CredentialsRow {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub kind: String,
    pub secret: String,
    pub injection: String,
    pub disabled_at: Option<i64>,
    pub rpm: Option<i64>,
    pub tpm: Option<i64>,
    pub consent_epoch: i64,
    pub runtime_epoch: i64,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ProviderResourcesRow {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub wire: String,
    pub base_url: String,
    pub headers: String,
    pub credential_id: Option<String>,
    pub consent_epoch: i64,
    pub runtime_epoch: i64,
    pub default_model: Option<String>,
    pub timeouts: String,
    pub rpm: Option<i64>,
    pub tpm: Option<i64>,
    pub disabled_at: Option<i64>,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ProviderModelsRow {
    pub resource_id: String,
    pub model_id: String,
    pub wire_model_name: String,
    pub kind: String,
    pub tokenizer_profile: String,
    pub max_input: i64,
    pub max_output: i64,
    pub dimension: Option<i64>,
    pub capabilities: String,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ProviderAttachmentsRow {
    pub id: String,
    pub resource_id: String,
    pub target_kind: String,
    pub target_owner: Option<String>,
    pub target_space: String,
    pub target_project: Option<String>,
    pub resource_epoch: i64,
    pub credential_epoch: Option<i64>,
    pub state: String,
    pub disclosure: String,
    pub expires_at: Option<i64>,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ProviderPreferencesRow {
    pub owner_id: String,
    pub scope_kind: String,
    pub scope_id: String,
    pub resource_id: String,
    pub model_id: String,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ProviderBudgetBucketsRow {
    pub budget_kind: String,
    pub budget_owner: String,
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    pub rpm_used: i64,
    pub tpm_reserved: i64,
    pub tpm_exact: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ProviderCallLogRow {
    pub call_id: String,
    pub owner_id: String,
    pub principal: String,
    pub run_id: Option<String>,
    pub scope_id: String,
    pub intent_key: String,
    pub request_hash: Vec<u8>,
    pub resource_id: String,
    pub credential_id: Option<String>,
    pub policy_epochs: String,
    pub participating_spaces: String,
    pub model_id: String,
    pub reserved_tokens: i64,
    pub bucket_keys: String,
    pub delivery_state: String,
    pub outcome: Option<String>,
    pub usage_source: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub diagnostic: Option<String>,
    pub dispatch_owner: Option<String>,
    pub created_at: i64,
    pub settled_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AbilityAvailabilityRow {
    pub placement: String,
    pub ability_id: String,
    pub mode: String,
    pub enabled: i64,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AbilityProjectBindingsRow {
    pub placement: String,
    pub ability_id: String,
    pub target_space: String,
    pub project_id: String,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AbilityPreferencesRow {
    pub owner_id: String,
    pub ability_id: String,
    pub placement: String,
    pub enabled: i64,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AbilityPlacementTrailRow {
    pub source_placement: String,
    pub ability_id: String,
    pub destination_placement: String,
    pub destination_id: String,
    pub manifest_ref: String,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct FavoritesRow {
    pub owner_id: String,
    pub space_id: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub rank: i64,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ContextSetsRow {
    pub set_id: String,
    pub owner_id: String,
    pub home_space: String,
    pub name: String,
    pub note_refs: String,
    pub revision: i64,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ContextSetAttachmentsRow {
    pub set_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub target_space: String,
    pub owner_id: String,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ContextScopePinsRow {
    pub owner_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub target_space: String,
    pub note_space: String,
    pub note_id: String,
    pub revision: i64,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ContextOrderRow {
    pub owner_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub target_space: String,
    pub entry_kind: String,
    pub entry_ref: String,
    pub rank: i64,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AgentEpisodesRow {
    pub episode_id: String,
    pub owner_id: String,
    pub name: Option<String>,
    pub parent_id: Option<String>,
    pub active_role: Option<String>,
    pub project_space: Option<String>,
    pub project_folder: Option<String>,
    pub lifecycle: String,
    pub revision: i64,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub closed_at: Option<i64>,
    pub calls: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct McpDeltaOwnerCursorsRow {
    pub owner_id: String,
    pub space_id: String,
    pub history_incarnation: Vec<u8>,
    pub acked_space_seq: i64,
    pub updated_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct McpDeltaSessionCursorsRow {
    pub episode_id: String,
    pub space_id: String,
    pub history_incarnation: Vec<u8>,
    pub acked_space_seq: i64,
    pub updated_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AgentTelemetryConfigRow {
    pub singleton: i64,
    pub detailed_enabled: i64,
    pub compact_retention_days: i64,
    pub detailed_retention_days: i64,
    pub version: i64,
    pub updated_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AgentCallsRow {
    pub call_id: String,
    pub owner_id: String,
    pub principal: String,
    pub agent: Option<String>,
    pub transport: String,
    pub request_id: String,
    pub episode_id: Option<String>,
    pub tool: String,
    pub effect: String,
    pub domain: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub outcome: Option<String>,
    pub reason: Option<String>,
    pub input_bytes: i64,
    pub output_bytes: Option<i64>,
    pub summaries: String,
    pub fingerprint: Vec<u8>,
    pub projection_version: i64,
    pub redacted: i64,
    pub truncated: i64,
    pub detail_capture_failed: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AgentCallDetailsRow {
    pub call_id: String,
    pub payload: String,
    pub created_at: i64,
    pub expires_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AgentRetrievalsRow {
    pub retrieval_id: String,
    pub owner_id: String,
    pub principal: String,
    pub agent: Option<String>,
    pub call_id: Option<String>,
    pub tool: String,
    pub query_summary: String,
    pub filters: String,
    pub hit_refs: String,
    pub result_count: i64,
    pub top_score: Option<f64>,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct McpDedupRow {
    pub owner: String,
    pub actor: String,
    pub request_key: String,
    pub request_hash: Vec<u8>,
    pub operation: String,
    pub safe_result: String,
    pub effect: String,
    pub expires_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AgentSchedulesRow {
    pub schedule_id: String,
    pub owner_id: String,
    pub space_id: String,
    pub project_folder_id: Option<String>,
    pub cron_expr: String,
    pub timezone: String,
    pub approved_role: String,
    pub paused_reason: Option<String>,
    pub write_class_mask: i64,
    pub budgets: String,
    pub misfire_policy: String,
    pub next_slot_utc_ms: i64,
    pub deleted_at: Option<i64>,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct AgentScheduleRunsRow {
    pub run_id: String,
    pub schedule_id: String,
    pub slot_utc_ms: i64,
    pub lease_epoch: i64,
    pub claim_request_hash: Vec<u8>,
    pub claimed_schedule_revision: i64,
    pub reserved_next_slot: i64,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub safe_result: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ControlCommandsRow {
    pub owner: String,
    pub actor: String,
    pub command_key: String,
    pub request_hash: Vec<u8>,
    pub target: String,
    pub expected: i64,
    pub result_revision: Option<i64>,
    pub state: String,
    pub safe_result: Option<String>,
    pub expires_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct ControlOperationsRow {
    pub operation_id: String,
    pub command_key: String,
    pub kind: String,
    pub target_space: String,
    pub state: String,
    pub payload_hash: Vec<u8>,
    pub payload: String,
    pub canonical_receipt: Option<String>,
    pub next_action: String,
    pub updated_at: i64,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct RevocationEventsRow {
    pub event_id: String,
    pub selector: String,
    pub reason: String,
    pub authority_version: i64,
    pub committed_at: i64,
    pub delivered_at: Option<i64>,
    pub attempts: i64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetTable {
    V1StorageEpoch,
    Users,
    UserOidcIdentities,
    SpaceAdmission,
    SpaceMembers,
    Sessions,
    OneTimeTokens,
    Pats,
    OauthClients,
    OauthGrants,
    OauthAuthCodes,
    OauthRefreshFamilies,
    OauthRefreshTokens,
    OauthAccessTokens,
    SecretKeyring,
    OidcTransactions,
    Credentials,
    ProviderResources,
    ProviderModels,
    ProviderAttachments,
    ProviderPreferences,
    ProviderBudgetBuckets,
    ProviderCallLog,
    AbilityAvailability,
    AbilityProjectBindings,
    AbilityPreferences,
    AbilityPlacementTrail,
    Favorites,
    ContextSets,
    ContextSetAttachments,
    ContextScopePins,
    ContextOrder,
    AgentEpisodes,
    McpDeltaOwnerCursors,
    McpDeltaSessionCursors,
    AgentTelemetryConfig,
    AgentCalls,
    AgentCallDetails,
    AgentRetrievals,
    McpDedup,
    AgentSchedules,
    AgentScheduleRuns,
    ControlCommands,
    ControlOperations,
    RevocationEvents,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "table", content = "row", rename_all = "snake_case")]
pub enum TargetRecord {
    V1StorageEpoch(V1StorageEpochRow),
    Users(UsersRow),
    UserOidcIdentities(UserOidcIdentitiesRow),
    SpaceAdmission(SpaceAdmissionRow),
    SpaceMembers(SpaceMembersRow),
    Sessions(SessionsRow),
    OneTimeTokens(OneTimeTokensRow),
    Pats(PatsRow),
    OauthClients(OauthClientsRow),
    OauthGrants(OauthGrantsRow),
    OauthAuthCodes(OauthAuthCodesRow),
    OauthRefreshFamilies(OauthRefreshFamiliesRow),
    OauthRefreshTokens(OauthRefreshTokensRow),
    OauthAccessTokens(OauthAccessTokensRow),
    SecretKeyring(SecretKeyringRow),
    OidcTransactions(OidcTransactionsRow),
    Credentials(CredentialsRow),
    ProviderResources(ProviderResourcesRow),
    ProviderModels(ProviderModelsRow),
    ProviderAttachments(ProviderAttachmentsRow),
    ProviderPreferences(ProviderPreferencesRow),
    ProviderBudgetBuckets(ProviderBudgetBucketsRow),
    ProviderCallLog(ProviderCallLogRow),
    AbilityAvailability(AbilityAvailabilityRow),
    AbilityProjectBindings(AbilityProjectBindingsRow),
    AbilityPreferences(AbilityPreferencesRow),
    AbilityPlacementTrail(AbilityPlacementTrailRow),
    Favorites(FavoritesRow),
    ContextSets(ContextSetsRow),
    ContextSetAttachments(ContextSetAttachmentsRow),
    ContextScopePins(ContextScopePinsRow),
    ContextOrder(ContextOrderRow),
    AgentEpisodes(AgentEpisodesRow),
    McpDeltaOwnerCursors(McpDeltaOwnerCursorsRow),
    McpDeltaSessionCursors(McpDeltaSessionCursorsRow),
    AgentTelemetryConfig(AgentTelemetryConfigRow),
    AgentCalls(AgentCallsRow),
    AgentCallDetails(AgentCallDetailsRow),
    AgentRetrievals(AgentRetrievalsRow),
    McpDedup(McpDedupRow),
    AgentSchedules(AgentSchedulesRow),
    AgentScheduleRuns(AgentScheduleRunsRow),
    ControlCommands(ControlCommandsRow),
    ControlOperations(ControlOperationsRow),
    RevocationEvents(RevocationEventsRow),
}
impl std::fmt::Debug for TargetRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TargetRecord")
            .field("table", &self.table())
            .finish_non_exhaustive()
    }
}
impl TargetRecord {
    pub fn table(&self) -> TargetTable {
        match self {
            Self::V1StorageEpoch(_) => TargetTable::V1StorageEpoch,
            Self::Users(_) => TargetTable::Users,
            Self::UserOidcIdentities(_) => TargetTable::UserOidcIdentities,
            Self::SpaceAdmission(_) => TargetTable::SpaceAdmission,
            Self::SpaceMembers(_) => TargetTable::SpaceMembers,
            Self::Sessions(_) => TargetTable::Sessions,
            Self::OneTimeTokens(_) => TargetTable::OneTimeTokens,
            Self::Pats(_) => TargetTable::Pats,
            Self::OauthClients(_) => TargetTable::OauthClients,
            Self::OauthGrants(_) => TargetTable::OauthGrants,
            Self::OauthAuthCodes(_) => TargetTable::OauthAuthCodes,
            Self::OauthRefreshFamilies(_) => TargetTable::OauthRefreshFamilies,
            Self::OauthRefreshTokens(_) => TargetTable::OauthRefreshTokens,
            Self::OauthAccessTokens(_) => TargetTable::OauthAccessTokens,
            Self::SecretKeyring(_) => TargetTable::SecretKeyring,
            Self::OidcTransactions(_) => TargetTable::OidcTransactions,
            Self::Credentials(_) => TargetTable::Credentials,
            Self::ProviderResources(_) => TargetTable::ProviderResources,
            Self::ProviderModels(_) => TargetTable::ProviderModels,
            Self::ProviderAttachments(_) => TargetTable::ProviderAttachments,
            Self::ProviderPreferences(_) => TargetTable::ProviderPreferences,
            Self::ProviderBudgetBuckets(_) => TargetTable::ProviderBudgetBuckets,
            Self::ProviderCallLog(_) => TargetTable::ProviderCallLog,
            Self::AbilityAvailability(_) => TargetTable::AbilityAvailability,
            Self::AbilityProjectBindings(_) => TargetTable::AbilityProjectBindings,
            Self::AbilityPreferences(_) => TargetTable::AbilityPreferences,
            Self::AbilityPlacementTrail(_) => TargetTable::AbilityPlacementTrail,
            Self::Favorites(_) => TargetTable::Favorites,
            Self::ContextSets(_) => TargetTable::ContextSets,
            Self::ContextSetAttachments(_) => TargetTable::ContextSetAttachments,
            Self::ContextScopePins(_) => TargetTable::ContextScopePins,
            Self::ContextOrder(_) => TargetTable::ContextOrder,
            Self::AgentEpisodes(_) => TargetTable::AgentEpisodes,
            Self::McpDeltaOwnerCursors(_) => TargetTable::McpDeltaOwnerCursors,
            Self::McpDeltaSessionCursors(_) => TargetTable::McpDeltaSessionCursors,
            Self::AgentTelemetryConfig(_) => TargetTable::AgentTelemetryConfig,
            Self::AgentCalls(_) => TargetTable::AgentCalls,
            Self::AgentCallDetails(_) => TargetTable::AgentCallDetails,
            Self::AgentRetrievals(_) => TargetTable::AgentRetrievals,
            Self::McpDedup(_) => TargetTable::McpDedup,
            Self::AgentSchedules(_) => TargetTable::AgentSchedules,
            Self::AgentScheduleRuns(_) => TargetTable::AgentScheduleRuns,
            Self::ControlCommands(_) => TargetTable::ControlCommands,
            Self::ControlOperations(_) => TargetTable::ControlOperations,
            Self::RevocationEvents(_) => TargetTable::RevocationEvents,
        }
    }
    pub(crate) fn validate(&self) -> Result<usize, PortError> {
        let mut bytes = 0usize;
        match self {
            Self::V1StorageEpoch(row) => {
                {
                    let value = &row.state;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.installation_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::InstallationId::parse(value)?;
                }
                if let Some(value) = row.receipt_sha256.as_ref() {
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                if let Some(value) = row.receipt_json.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(8usize)?;
            }
            Self::Users(row) => {
                {
                    let value = &row.user_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.username;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.email.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.display_name;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.password_hash.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.personal_space_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.user_id.len())?;
                validate_index(row.username.len())?;
                validate_index(row.email.as_ref().map_or(0, |value| value.len()))?;
                validate_index(
                    row.personal_space_id
                        .as_ref()
                        .map_or(0, |value| value.len()),
                )?;
            }
            Self::UserOidcIdentities(row) => {
                {
                    let value = &row.issuer;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.subject;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.user_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                validate_index(row.issuer.len() + row.subject.len())?;
                validate_index(row.user_id.len())?;
            }
            Self::SpaceAdmission(row) => {
                {
                    let value = &row.space_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.state;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.space_id.len())?;
            }
            Self::SpaceMembers(row) => {
                {
                    let value = &row.space_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.user_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.role;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.admission;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.space_id.len() + row.user_id.len())?;
                validate_index(row.user_id.len() + row.space_id.len())?;
            }
            Self::Sessions(row) => {
                {
                    let value = &row.session_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::AuthSessionId::parse(value)?;
                }
                {
                    let value = &row.token_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.user_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                validate_index(row.session_id.len())?;
                validate_index(row.token_hash.len())?;
                validate_index(row.user_id.len() + 8usize)?;
                validate_index(8usize)?;
            }
            Self::OneTimeTokens(row) => {
                {
                    let value = &row.token_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.user_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.purpose;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.token_hash.len())?;
                validate_index(row.user_id.len() + row.purpose.len() + 8usize)?;
            }
            Self::Pats(row) => {
                {
                    let value = &row.token_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    if value.len() != 12
                        || !value
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidId,
                        ));
                    }
                }
                {
                    let value = &row.secret_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.user_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.name;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.scope;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.selected_spaces.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.token_id.len())?;
                validate_index(row.user_id.len() + row.token_id.len())?;
            }
            Self::OauthClients(row) => {
                {
                    let value = &row.client_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.redirect_uris;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.client_name;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.metadata_uri.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.metadata_digest.as_ref() {
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                validate_index(row.client_id.len())?;
                validate_index(8usize + 8usize)?;
            }
            Self::OauthGrants(row) => {
                {
                    let value = &row.grant_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::OAuthGrantId::parse(value)?;
                }
                {
                    let value = &row.user_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.client_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.resource_uri;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.scope;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.selected_spaces.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.grant_id.len())?;
                validate_index(row.user_id.len() + row.client_id.len())?;
                validate_index(row.client_id.len())?;
            }
            Self::OauthAuthCodes(row) => {
                {
                    let value = &row.code_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.grant_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::OAuthGrantId::parse(value)?;
                }
                {
                    let value = &row.client_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.redirect_uri;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.resource_uri;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.code_challenge;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.method;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.code_hash.len())?;
                validate_index(8usize)?;
            }
            Self::OauthRefreshFamilies(row) => {
                {
                    let value = &row.family_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::OAuthFamilyId::parse(value)?;
                }
                {
                    let value = &row.grant_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::OAuthGrantId::parse(value)?;
                }
                if let Some(value) = row.reason_code.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.family_id.len())?;
                validate_index(row.grant_id.len())?;
            }
            Self::OauthRefreshTokens(row) => {
                {
                    let value = &row.token_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    if value.len() != 12
                        || !value
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidId,
                        ));
                    }
                }
                {
                    let value = &row.token_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.family_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::OAuthFamilyId::parse(value)?;
                }
                {
                    let value = &row.client_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.rotated_to.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.token_id.len())?;
                validate_index(row.family_id.len())?;
                validate_index(8usize)?;
            }
            Self::OauthAccessTokens(row) => {
                {
                    let value = &row.token_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    if value.len() != 12
                        || !value
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidId,
                        ));
                    }
                }
                {
                    let value = &row.token_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.grant_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::OAuthGrantId::parse(value)?;
                }
                if let Some(value) = row.family_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::OAuthFamilyId::parse(value)?;
                }
                if let Some(value) = row.refresh_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.resource_uri;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.scope;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.selected_spaces.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.token_id.len())?;
                validate_index(row.grant_id.len())?;
                validate_index(row.family_id.as_ref().map_or(0, |value| value.len()))?;
                validate_index(8usize)?;
            }
            Self::SecretKeyring(row) => {
                {
                    let value = &row.key_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::KeyId::parse(value)?;
                }
                {
                    let value = &row.key_hash;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    if !value.strip_prefix("sha256:").is_some_and(|hash| {
                        hash.len() == 64
                            && hash
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    }) {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidState,
                        ));
                    }
                }
                {
                    let value = &row.state;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.canary;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.key_id.len())?;
                validate_index(8usize)?;
                validate_index(row.state.len())?;
            }
            Self::OidcTransactions(row) => {
                {
                    let value = &row.transaction_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.state_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.nonce_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.flow_context_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.key_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::KeyId::parse(value)?;
                }
                {
                    let value = &row.issuer;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.client_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.redirect_uri;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.purpose;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.bound_user.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.browser_binding_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                validate_index(row.transaction_id.len())?;
                validate_index(row.state_hash.len())?;
                validate_index(8usize)?;
            }
            Self::Credentials(row) => {
                {
                    let value = &row.id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.name;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.secret;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.injection;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.id.len())?;
                validate_index(row.owner_id.len() + row.name.len())?;
            }
            Self::ProviderResources(row) => {
                {
                    let value = &row.id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.name;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.wire;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.base_url;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.headers;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.credential_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::CredentialId::parse(value)?;
                }
                if let Some(value) = row.default_model.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.timeouts;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.id.len())?;
                validate_index(row.owner_id.len() + row.name.len())?;
                validate_index(row.credential_id.as_ref().map_or(0, |value| value.len()))?;
            }
            Self::ProviderModels(row) => {
                {
                    let value = &row.resource_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ProviderResourceId::parse(value)?;
                }
                {
                    let value = &row.model_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ModelProfileId::parse(value)?;
                }
                {
                    let value = &row.wire_model_name;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.tokenizer_profile;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.capabilities;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.resource_id.len() + row.model_id.len())?;
            }
            Self::ProviderAttachments(row) => {
                {
                    let value = &row.id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.resource_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ProviderResourceId::parse(value)?;
                }
                {
                    let value = &row.target_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.target_owner.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.target_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                if let Some(value) = row.target_project.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::FolderId::parse(value)?;
                }
                {
                    let value = &row.state;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.disclosure;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.id.len())?;
                validate_index(
                    row.resource_id.len()
                        + row.target_owner.as_ref().map_or(0, |value| value.len())
                        + row.target_space.len(),
                )?;
                validate_index(row.resource_id.len() + row.target_space.len())?;
                validate_index(
                    row.resource_id.len()
                        + row.target_space.len()
                        + row.target_project.as_ref().map_or(0, |value| value.len()),
                )?;
                validate_index(row.target_space.len() + row.state.len() + row.resource_id.len())?;
            }
            Self::ProviderPreferences(row) => {
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.scope_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.scope_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.resource_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ProviderResourceId::parse(value)?;
                }
                {
                    let value = &row.model_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ModelProfileId::parse(value)?;
                }
                validate_index(row.owner_id.len() + row.scope_kind.len() + row.scope_id.len())?;
            }
            Self::ProviderBudgetBuckets(row) => {
                {
                    let value = &row.budget_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.budget_owner;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.budget_kind.len() + row.budget_owner.len() + 8usize)?;
            }
            Self::ProviderCallLog(row) => {
                {
                    let value = &row.call_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.principal;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.run_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::AgentRunId::parse(value)?;
                }
                {
                    let value = &row.scope_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.intent_key;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.request_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.resource_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ProviderResourceId::parse(value)?;
                }
                if let Some(value) = row.credential_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::CredentialId::parse(value)?;
                }
                {
                    let value = &row.policy_epochs;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.participating_spaces;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.model_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ModelProfileId::parse(value)?;
                }
                {
                    let value = &row.bucket_keys;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.delivery_state;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.outcome.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.usage_source;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.diagnostic.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.dispatch_owner.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.call_id.len())?;
                validate_index(row.principal.len() + row.scope_id.len() + row.intent_key.len())?;
                validate_index(row.owner_id.len() + 8usize + row.call_id.len())?;
                validate_index(row.delivery_state.len() + 8usize + row.call_id.len())?;
            }
            Self::AbilityAvailability(row) => {
                {
                    let value = &row.placement;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.ability_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::AbilityId::parse(value)?;
                }
                {
                    let value = &row.mode;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.placement.len() + row.ability_id.len())?;
            }
            Self::AbilityProjectBindings(row) => {
                {
                    let value = &row.placement;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.ability_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::AbilityId::parse(value)?;
                }
                {
                    let value = &row.target_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.project_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::FolderId::parse(value)?;
                }
                validate_index(
                    row.placement.len()
                        + row.ability_id.len()
                        + row.target_space.len()
                        + row.project_id.len(),
                )?;
                validate_index(row.target_space.len() + row.project_id.len())?;
            }
            Self::AbilityPreferences(row) => {
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.ability_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::AbilityId::parse(value)?;
                }
                {
                    let value = &row.placement;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.owner_id.len() + row.ability_id.len() + row.placement.len())?;
            }
            Self::AbilityPlacementTrail(row) => {
                {
                    let value = &row.source_placement;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.ability_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::AbilityId::parse(value)?;
                }
                {
                    let value = &row.destination_placement;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.destination_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.manifest_ref;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.source_placement.len() + row.ability_id.len())?;
            }
            Self::Favorites(row) => {
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.space_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.entity_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.entity_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(
                    row.owner_id.len()
                        + row.space_id.len()
                        + row.entity_kind.len()
                        + row.entity_id.len(),
                )?;
                validate_index(
                    row.owner_id.len() + row.space_id.len() + 8usize + row.entity_id.len(),
                )?;
            }
            Self::ContextSets(row) => {
                {
                    let value = &row.set_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.home_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.name;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.note_refs;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.set_id.len())?;
                validate_index(row.home_space.len() + row.set_id.len())?;
            }
            Self::ContextSetAttachments(row) => {
                {
                    let value = &row.set_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                validate_index(row.set_id.len() + row.target_kind.len() + row.target_id.len())?;
                validate_index(
                    row.owner_id.len()
                        + row.target_kind.len()
                        + row.target_id.len()
                        + row.set_id.len(),
                )?;
            }
            Self::ContextScopePins(row) => {
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.target_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.note_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.note_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::NoteId::parse(value)?;
                }
                validate_index(
                    row.owner_id.len()
                        + row.target_kind.len()
                        + row.target_id.len()
                        + row.note_space.len()
                        + row.note_id.len(),
                )?;
                validate_index(row.target_space.len() + row.note_space.len())?;
            }
            Self::ContextOrder(row) => {
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.target_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.entry_kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.entry_ref;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(
                    row.owner_id.len()
                        + row.target_kind.len()
                        + row.target_id.len()
                        + row.entry_kind.len()
                        + row.entry_ref.len(),
                )?;
                validate_index(
                    row.owner_id.len()
                        + row.target_kind.len()
                        + row.target_id.len()
                        + 8usize
                        + row.entry_ref.len(),
                )?;
            }
            Self::AgentEpisodes(row) => {
                {
                    let value = &row.episode_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::EpisodeId::parse(value)?;
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                if let Some(value) = row.name.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.parent_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.active_role.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.project_space.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                if let Some(value) = row.project_folder.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::FolderId::parse(value)?;
                }
                {
                    let value = &row.lifecycle;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.episode_id.len())?;
                validate_index(
                    row.owner_id.len()
                        + row.name.as_ref().map_or(0, |value| value.len())
                        + row.lifecycle.len()
                        + 8usize
                        + row.episode_id.len(),
                )?;
            }
            Self::McpDeltaOwnerCursors(row) => {
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.space_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.history_incarnation;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                validate_index(row.owner_id.len() + row.space_id.len())?;
            }
            Self::McpDeltaSessionCursors(row) => {
                {
                    let value = &row.episode_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::EpisodeId::parse(value)?;
                }
                {
                    let value = &row.space_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.history_incarnation;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                validate_index(row.episode_id.len() + row.space_id.len())?;
                validate_index(row.space_id.len())?;
            }
            Self::AgentTelemetryConfig(_) => {
                validate_index(8usize)?;
            }
            Self::AgentCalls(row) => {
                {
                    let value = &row.call_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.principal;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.agent.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.transport;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.request_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.episode_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::EpisodeId::parse(value)?;
                }
                {
                    let value = &row.tool;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.effect;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.domain;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.outcome.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.reason.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.summaries;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.fingerprint;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                validate_index(row.call_id.len())?;
                validate_index(row.owner_id.len() + 8usize + row.call_id.len())?;
                validate_index(
                    row.owner_id.len()
                        + row.episode_id.as_ref().map_or(0, |value| value.len())
                        + 8usize
                        + row.call_id.len(),
                )?;
                validate_index(8usize + 8usize)?;
            }
            Self::AgentCallDetails(row) => {
                {
                    let value = &row.call_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.payload;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.call_id.len())?;
                validate_index(8usize)?;
            }
            Self::AgentRetrievals(row) => {
                {
                    let value = &row.retrieval_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.principal;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.agent.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.call_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.tool;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.query_summary;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.filters;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.hit_refs;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if row.top_score.is_some_and(|value| !value.is_finite()) {
                    return Err(crate::error::invalid(
                        notarium_core::error::ValidationReason::InvalidNumber,
                    ));
                }
                validate_index(row.retrieval_id.len())?;
                validate_index(row.owner_id.len() + 8usize + row.retrieval_id.len())?;
                validate_index(row.call_id.as_ref().map_or(0, |value| value.len()))?;
            }
            Self::McpDedup(row) => {
                {
                    let value = &row.owner;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.actor;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.request_key;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.request_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.operation;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.safe_result;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.effect;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.owner.len() + row.actor.len() + row.request_key.len())?;
                validate_index(8usize)?;
            }
            Self::AgentSchedules(row) => {
                {
                    let value = &row.schedule_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ScheduleId::parse(value)?;
                }
                {
                    let value = &row.owner_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.space_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                if let Some(value) = row.project_folder_id.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::FolderId::parse(value)?;
                }
                {
                    let value = &row.cron_expr;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.timezone;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.approved_role;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.paused_reason.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.budgets;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.misfire_policy;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.schedule_id.len())?;
                validate_index(
                    8usize
                        + row.paused_reason.as_ref().map_or(0, |value| value.len())
                        + 8usize
                        + row.schedule_id.len(),
                )?;
                validate_index(row.owner_id.len() + row.space_id.len() + row.schedule_id.len())?;
            }
            Self::AgentScheduleRuns(row) => {
                {
                    let value = &row.run_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::AgentRunId::parse(value)?;
                }
                {
                    let value = &row.schedule_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::ScheduleId::parse(value)?;
                }
                {
                    let value = &row.claim_request_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.status;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.safe_result.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.run_id.len())?;
                validate_index(row.schedule_id.len() + 8usize)?;
                validate_index(
                    row.schedule_id.len() + row.status.len() + 8usize + row.run_id.len(),
                )?;
            }
            Self::ControlCommands(row) => {
                {
                    let value = &row.owner;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::PrincipalId::parse(value)?;
                }
                {
                    let value = &row.actor;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.command_key;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.request_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.target;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.state;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.safe_result.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.owner.len() + row.actor.len() + row.command_key.len())?;
                validate_index(row.state.len() + 8usize)?;
            }
            Self::ControlOperations(row) => {
                {
                    let value = &row.operation_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.command_key;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.kind;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.target_space;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                    notarium_core::ids::SpaceId::parse(value)?;
                }
                {
                    let value = &row.state;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.payload_hash;
                    if value.len() > 1048576 {
                        return Err(crate::error::invalid(
                            notarium_core::error::ValidationReason::InvalidLimit,
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                }
                {
                    let value = &row.payload;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                if let Some(value) = row.canonical_receipt.as_ref() {
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.next_action;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.operation_id.len())?;
                validate_index(row.command_key.len())?;
                validate_index(row.state.len() + 8usize)?;
            }
            Self::RevocationEvents(row) => {
                {
                    let value = &row.event_id;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.selector;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                {
                    let value = &row.reason;
                    bytes = bytes.saturating_add(text_bytes(value)?);
                }
                validate_index(row.event_id.len())?;
                validate_index(8usize + 8usize + row.event_id.len())?;
            }
        }
        Ok(bytes)
    }
    pub(crate) async fn insert(&self, tx: &mut Transaction) -> Result<(), PortError> {
        match self {
            Self::V1StorageEpoch(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO v1_storage_epoch(singleton,epoch_version,state,installation_id,receipt_sha256,receipt_json) VALUES($1,$2,$3,$4,$5,$6)").bind(row.singleton).bind(row.epoch_version).bind(&row.state).bind(&row.installation_id).bind(&row.receipt_sha256).bind(&row.receipt_json).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.v1_storage_epoch(singleton,epoch_version,state,installation_id,receipt_sha256,receipt_json) VALUES($1,$2,$3,$4,$5,$6)").bind(row.singleton).bind(row.epoch_version).bind(&row.state).bind(&row.installation_id).bind(&row.receipt_sha256).bind(&row.receipt_json).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::Users(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO users(user_id,username,email,display_name,password_hash,is_admin,disabled_at,personal_space_id,revision,auth_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&row.user_id).bind(&row.username).bind(&row.email).bind(&row.display_name).bind(&row.password_hash).bind(row.is_admin).bind(row.disabled_at).bind(&row.personal_space_id).bind(row.revision).bind(row.auth_version).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.users(user_id,username,email,display_name,password_hash,is_admin,disabled_at,personal_space_id,revision,auth_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&row.user_id).bind(&row.username).bind(&row.email).bind(&row.display_name).bind(&row.password_hash).bind(row.is_admin).bind(row.disabled_at).bind(&row.personal_space_id).bind(row.revision).bind(row.auth_version).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::UserOidcIdentities(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO user_oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,$4)").bind(&row.issuer).bind(&row.subject).bind(&row.user_id).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.user_oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,$4)").bind(&row.issuer).bind(&row.subject).bind(&row.user_id).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::SpaceAdmission(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO space_admission(space_id,state,admission_epoch,revision) VALUES($1,$2,$3,$4)").bind(&row.space_id).bind(&row.state).bind(row.admission_epoch).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.space_admission(space_id,state,admission_epoch,revision) VALUES($1,$2,$3,$4)").bind(&row.space_id).bind(&row.state).bind(row.admission_epoch).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::SpaceMembers(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO space_members(space_id,user_id,role,admission,revision,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.space_id).bind(&row.user_id).bind(&row.role).bind(&row.admission).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.space_members(space_id,user_id,role,admission,revision,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.space_id).bind(&row.user_id).bind(&row.role).bind(&row.admission).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::Sessions(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO sessions(session_id,token_hash,user_id,created_at,expires_at,last_used_at,revoked_at,auth_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.session_id).bind(&row.token_hash).bind(&row.user_id).bind(row.created_at).bind(row.expires_at).bind(row.last_used_at).bind(row.revoked_at).bind(row.auth_version).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.sessions(session_id,token_hash,user_id,created_at,expires_at,last_used_at,revoked_at,auth_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.session_id).bind(&row.token_hash).bind(&row.user_id).bind(row.created_at).bind(row.expires_at).bind(row.last_used_at).bind(row.revoked_at).bind(row.auth_version).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OneTimeTokens(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO one_time_tokens(token_hash,user_id,purpose,expires_at,used_at,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.token_hash).bind(&row.user_id).bind(&row.purpose).bind(row.expires_at).bind(row.used_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.one_time_tokens(token_hash,user_id,purpose,expires_at,used_at,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.token_hash).bind(&row.user_id).bind(&row.purpose).bind(row.expires_at).bind(row.used_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::Pats(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO pats(token_id,secret_hash,user_id,name,scope,selected_spaces,expires_at,last_used_at,revoked_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.token_id).bind(&row.secret_hash).bind(&row.user_id).bind(&row.name).bind(&row.scope).bind(&row.selected_spaces).bind(row.expires_at).bind(row.last_used_at).bind(row.revoked_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.pats(token_id,secret_hash,user_id,name,scope,selected_spaces,expires_at,last_used_at,revoked_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.token_id).bind(&row.secret_hash).bind(&row.user_id).bind(&row.name).bind(&row.scope).bind(&row.selected_spaces).bind(row.expires_at).bind(row.last_used_at).bind(row.revoked_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OauthClients(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO oauth_clients(client_id,kind,redirect_uris,client_name,metadata_uri,metadata_digest,cache_expires_at,activated_at,created_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.client_id).bind(&row.kind).bind(&row.redirect_uris).bind(&row.client_name).bind(&row.metadata_uri).bind(&row.metadata_digest).bind(row.cache_expires_at).bind(row.activated_at).bind(row.created_at).bind(row.last_seen_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.oauth_clients(client_id,kind,redirect_uris,client_name,metadata_uri,metadata_digest,cache_expires_at,activated_at,created_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.client_id).bind(&row.kind).bind(&row.redirect_uris).bind(&row.client_name).bind(&row.metadata_uri).bind(&row.metadata_digest).bind(row.cache_expires_at).bind(row.activated_at).bind(row.created_at).bind(row.last_seen_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OauthGrants(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO oauth_grants(grant_id,user_id,client_id,resource_uri,scope,selected_spaces,revoked_at,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(&row.grant_id).bind(&row.user_id).bind(&row.client_id).bind(&row.resource_uri).bind(&row.scope).bind(&row.selected_spaces).bind(row.revoked_at).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.oauth_grants(grant_id,user_id,client_id,resource_uri,scope,selected_spaces,revoked_at,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(&row.grant_id).bind(&row.user_id).bind(&row.client_id).bind(&row.resource_uri).bind(&row.scope).bind(&row.selected_spaces).bind(row.revoked_at).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OauthAuthCodes(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO oauth_auth_codes(code_hash,grant_id,client_id,redirect_uri,resource_uri,code_challenge,method,offline_access,expires_at,used_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&row.code_hash).bind(&row.grant_id).bind(&row.client_id).bind(&row.redirect_uri).bind(&row.resource_uri).bind(&row.code_challenge).bind(&row.method).bind(row.offline_access).bind(row.expires_at).bind(row.used_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.oauth_auth_codes(code_hash,grant_id,client_id,redirect_uri,resource_uri,code_challenge,method,offline_access,expires_at,used_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&row.code_hash).bind(&row.grant_id).bind(&row.client_id).bind(&row.redirect_uri).bind(&row.resource_uri).bind(&row.code_challenge).bind(&row.method).bind(row.offline_access).bind(row.expires_at).bind(row.used_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OauthRefreshFamilies(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO oauth_refresh_families(family_id,grant_id,revoked_at,reason_code,created_at) VALUES($1,$2,$3,$4,$5)").bind(&row.family_id).bind(&row.grant_id).bind(row.revoked_at).bind(&row.reason_code).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.oauth_refresh_families(family_id,grant_id,revoked_at,reason_code,created_at) VALUES($1,$2,$3,$4,$5)").bind(&row.family_id).bind(&row.grant_id).bind(row.revoked_at).bind(&row.reason_code).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OauthRefreshTokens(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO oauth_refresh_tokens(token_id,token_hash,family_id,client_id,issued_at,expires_at,used_at,revoked_at,rotated_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(&row.token_id).bind(&row.token_hash).bind(&row.family_id).bind(&row.client_id).bind(row.issued_at).bind(row.expires_at).bind(row.used_at).bind(row.revoked_at).bind(&row.rotated_to).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.oauth_refresh_tokens(token_id,token_hash,family_id,client_id,issued_at,expires_at,used_at,revoked_at,rotated_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(&row.token_id).bind(&row.token_hash).bind(&row.family_id).bind(&row.client_id).bind(row.issued_at).bind(row.expires_at).bind(row.used_at).bind(row.revoked_at).bind(&row.rotated_to).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OauthAccessTokens(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO oauth_access_tokens(token_id,token_hash,grant_id,family_id,refresh_id,resource_uri,scope,selected_spaces,issued_at,expires_at,revoked_at,last_used_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(&row.token_id).bind(&row.token_hash).bind(&row.grant_id).bind(&row.family_id).bind(&row.refresh_id).bind(&row.resource_uri).bind(&row.scope).bind(&row.selected_spaces).bind(row.issued_at).bind(row.expires_at).bind(row.revoked_at).bind(row.last_used_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.oauth_access_tokens(token_id,token_hash,grant_id,family_id,refresh_id,resource_uri,scope,selected_spaces,issued_at,expires_at,revoked_at,last_used_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(&row.token_id).bind(&row.token_hash).bind(&row.grant_id).bind(&row.family_id).bind(&row.refresh_id).bind(&row.resource_uri).bind(&row.scope).bind(&row.selected_spaces).bind(row.issued_at).bind(row.expires_at).bind(row.revoked_at).bind(row.last_used_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::SecretKeyring(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO secret_keyring(key_id,key_hash,generation,state,canary,created_at,retired_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.key_id).bind(&row.key_hash).bind(row.generation).bind(&row.state).bind(&row.canary).bind(row.created_at).bind(row.retired_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.secret_keyring(key_id,key_hash,generation,state,canary,created_at,retired_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.key_id).bind(&row.key_hash).bind(row.generation).bind(&row.state).bind(&row.canary).bind(row.created_at).bind(row.retired_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::OidcTransactions(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO oidc_transactions(transaction_id,state_hash,nonce_hash,flow_context_hash,key_id,issuer,client_id,redirect_uri,purpose,bound_user,browser_binding_hash,expires_at,consumed_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)").bind(&row.transaction_id).bind(&row.state_hash).bind(&row.nonce_hash).bind(&row.flow_context_hash).bind(&row.key_id).bind(&row.issuer).bind(&row.client_id).bind(&row.redirect_uri).bind(&row.purpose).bind(&row.bound_user).bind(&row.browser_binding_hash).bind(row.expires_at).bind(row.consumed_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.oidc_transactions(transaction_id,state_hash,nonce_hash,flow_context_hash,key_id,issuer,client_id,redirect_uri,purpose,bound_user,browser_binding_hash,expires_at,consumed_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)").bind(&row.transaction_id).bind(&row.state_hash).bind(&row.nonce_hash).bind(&row.flow_context_hash).bind(&row.key_id).bind(&row.issuer).bind(&row.client_id).bind(&row.redirect_uri).bind(&row.purpose).bind(&row.bound_user).bind(&row.browser_binding_hash).bind(row.expires_at).bind(row.consumed_at).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::Credentials(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO credentials(id,owner_id,name,kind,secret,injection,disabled_at,rpm,tpm,consent_epoch,runtime_epoch,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)").bind(&row.id).bind(&row.owner_id).bind(&row.name).bind(&row.kind).bind(&row.secret).bind(&row.injection).bind(row.disabled_at).bind(row.rpm).bind(row.tpm).bind(row.consent_epoch).bind(row.runtime_epoch).bind(row.revision).bind(row.created_at).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.credentials(id,owner_id,name,kind,secret,injection,disabled_at,rpm,tpm,consent_epoch,runtime_epoch,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)").bind(&row.id).bind(&row.owner_id).bind(&row.name).bind(&row.kind).bind(&row.secret).bind(&row.injection).bind(row.disabled_at).bind(row.rpm).bind(row.tpm).bind(row.consent_epoch).bind(row.runtime_epoch).bind(row.revision).bind(row.created_at).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ProviderResources(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO provider_resources(id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,default_model,timeouts,rpm,tpm,disabled_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)").bind(&row.id).bind(&row.owner_id).bind(&row.name).bind(&row.wire).bind(&row.base_url).bind(&row.headers).bind(&row.credential_id).bind(row.consent_epoch).bind(row.runtime_epoch).bind(&row.default_model).bind(&row.timeouts).bind(row.rpm).bind(row.tpm).bind(row.disabled_at).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.provider_resources(id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,default_model,timeouts,rpm,tpm,disabled_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)").bind(&row.id).bind(&row.owner_id).bind(&row.name).bind(&row.wire).bind(&row.base_url).bind(&row.headers).bind(&row.credential_id).bind(row.consent_epoch).bind(row.runtime_epoch).bind(&row.default_model).bind(&row.timeouts).bind(row.rpm).bind(row.tpm).bind(row.disabled_at).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ProviderModels(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO provider_models(resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.resource_id).bind(&row.model_id).bind(&row.wire_model_name).bind(&row.kind).bind(&row.tokenizer_profile).bind(row.max_input).bind(row.max_output).bind(row.dimension).bind(&row.capabilities).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.provider_models(resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.resource_id).bind(&row.model_id).bind(&row.wire_model_name).bind(&row.kind).bind(&row.tokenizer_profile).bind(row.max_input).bind(row.max_output).bind(row.dimension).bind(&row.capabilities).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ProviderAttachments(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO provider_attachments(id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(&row.id).bind(&row.resource_id).bind(&row.target_kind).bind(&row.target_owner).bind(&row.target_space).bind(&row.target_project).bind(row.resource_epoch).bind(row.credential_epoch).bind(&row.state).bind(&row.disclosure).bind(row.expires_at).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.provider_attachments(id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(&row.id).bind(&row.resource_id).bind(&row.target_kind).bind(&row.target_owner).bind(&row.target_space).bind(&row.target_project).bind(row.resource_epoch).bind(row.credential_epoch).bind(&row.state).bind(&row.disclosure).bind(row.expires_at).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ProviderPreferences(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO provider_preferences(owner_id,scope_kind,scope_id,resource_id,model_id,revision) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.owner_id).bind(&row.scope_kind).bind(&row.scope_id).bind(&row.resource_id).bind(&row.model_id).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.provider_preferences(owner_id,scope_kind,scope_id,resource_id,model_id,revision) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.owner_id).bind(&row.scope_kind).bind(&row.scope_id).bind(&row.resource_id).bind(&row.model_id).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ProviderBudgetBuckets(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO provider_budget_buckets(budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.budget_kind).bind(&row.budget_owner).bind(row.window_start_ms).bind(row.window_end_ms).bind(row.rpm_used).bind(row.tpm_reserved).bind(row.tpm_exact).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.provider_budget_buckets(budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.budget_kind).bind(&row.budget_owner).bind(row.window_start_ms).bind(row.window_end_ms).bind(row.rpm_used).bind(row.tpm_reserved).bind(row.tpm_exact).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ProviderCallLog(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO provider_call_log(call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)").bind(&row.call_id).bind(&row.owner_id).bind(&row.principal).bind(&row.run_id).bind(&row.scope_id).bind(&row.intent_key).bind(&row.request_hash).bind(&row.resource_id).bind(&row.credential_id).bind(&row.policy_epochs).bind(&row.participating_spaces).bind(&row.model_id).bind(row.reserved_tokens).bind(&row.bucket_keys).bind(&row.delivery_state).bind(&row.outcome).bind(&row.usage_source).bind(row.input_tokens).bind(row.output_tokens).bind(&row.diagnostic).bind(&row.dispatch_owner).bind(row.created_at).bind(row.settled_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.provider_call_log(call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)").bind(&row.call_id).bind(&row.owner_id).bind(&row.principal).bind(&row.run_id).bind(&row.scope_id).bind(&row.intent_key).bind(&row.request_hash).bind(&row.resource_id).bind(&row.credential_id).bind(&row.policy_epochs).bind(&row.participating_spaces).bind(&row.model_id).bind(row.reserved_tokens).bind(&row.bucket_keys).bind(&row.delivery_state).bind(&row.outcome).bind(&row.usage_source).bind(row.input_tokens).bind(row.output_tokens).bind(&row.diagnostic).bind(&row.dispatch_owner).bind(row.created_at).bind(row.settled_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AbilityAvailability(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,$3,$4,$5)").bind(&row.placement).bind(&row.ability_id).bind(&row.mode).bind(row.enabled).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,$3,$4,$5)").bind(&row.placement).bind(&row.ability_id).bind(&row.mode).bind(row.enabled).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AbilityProjectBindings(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO ability_project_bindings(placement,ability_id,target_space,project_id) VALUES($1,$2,$3,$4)").bind(&row.placement).bind(&row.ability_id).bind(&row.target_space).bind(&row.project_id).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.ability_project_bindings(placement,ability_id,target_space,project_id) VALUES($1,$2,$3,$4)").bind(&row.placement).bind(&row.ability_id).bind(&row.target_space).bind(&row.project_id).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AbilityPreferences(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO ability_preferences(owner_id,ability_id,placement,enabled,revision) VALUES($1,$2,$3,$4,$5)").bind(&row.owner_id).bind(&row.ability_id).bind(&row.placement).bind(row.enabled).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.ability_preferences(owner_id,ability_id,placement,enabled,revision) VALUES($1,$2,$3,$4,$5)").bind(&row.owner_id).bind(&row.ability_id).bind(&row.placement).bind(row.enabled).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AbilityPlacementTrail(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO ability_placement_trail(source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.source_placement).bind(&row.ability_id).bind(&row.destination_placement).bind(&row.destination_id).bind(&row.manifest_ref).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.ability_placement_trail(source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.source_placement).bind(&row.ability_id).bind(&row.destination_placement).bind(&row.destination_id).bind(&row.manifest_ref).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::Favorites(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO favorites(owner_id,space_id,entity_kind,entity_id,rank,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.owner_id).bind(&row.space_id).bind(&row.entity_kind).bind(&row.entity_id).bind(row.rank).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.favorites(owner_id,space_id,entity_kind,entity_id,rank,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.owner_id).bind(&row.space_id).bind(&row.entity_kind).bind(&row.entity_id).bind(row.rank).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ContextSets(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO context_sets(set_id,owner_id,home_space,name,note_refs,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.set_id).bind(&row.owner_id).bind(&row.home_space).bind(&row.name).bind(&row.note_refs).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.context_sets(set_id,owner_id,home_space,name,note_refs,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.set_id).bind(&row.owner_id).bind(&row.home_space).bind(&row.name).bind(&row.note_refs).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ContextSetAttachments(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO context_set_attachments(set_id,target_kind,target_id,target_space,owner_id,revision) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.set_id).bind(&row.target_kind).bind(&row.target_id).bind(&row.target_space).bind(&row.owner_id).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.context_set_attachments(set_id,target_kind,target_id,target_space,owner_id,revision) VALUES($1,$2,$3,$4,$5,$6)").bind(&row.set_id).bind(&row.target_kind).bind(&row.target_id).bind(&row.target_space).bind(&row.owner_id).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ContextScopePins(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO context_scope_pins(owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.owner_id).bind(&row.target_kind).bind(&row.target_id).bind(&row.target_space).bind(&row.note_space).bind(&row.note_id).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.context_scope_pins(owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.owner_id).bind(&row.target_kind).bind(&row.target_id).bind(&row.target_space).bind(&row.note_space).bind(&row.note_id).bind(row.revision).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ContextOrder(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO context_order(owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.owner_id).bind(&row.target_kind).bind(&row.target_id).bind(&row.target_space).bind(&row.entry_kind).bind(&row.entry_ref).bind(row.rank).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.context_order(owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.owner_id).bind(&row.target_kind).bind(&row.target_id).bind(&row.target_space).bind(&row.entry_kind).bind(&row.entry_ref).bind(row.rank).bind(row.revision).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AgentEpisodes(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO agent_episodes(episode_id,owner_id,name,parent_id,active_role,project_space,project_folder,lifecycle,revision,created_at,last_seen_at,closed_at,calls) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)").bind(&row.episode_id).bind(&row.owner_id).bind(&row.name).bind(&row.parent_id).bind(&row.active_role).bind(&row.project_space).bind(&row.project_folder).bind(&row.lifecycle).bind(row.revision).bind(row.created_at).bind(row.last_seen_at).bind(row.closed_at).bind(row.calls).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.agent_episodes(episode_id,owner_id,name,parent_id,active_role,project_space,project_folder,lifecycle,revision,created_at,last_seen_at,closed_at,calls) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)").bind(&row.episode_id).bind(&row.owner_id).bind(&row.name).bind(&row.parent_id).bind(&row.active_role).bind(&row.project_space).bind(&row.project_folder).bind(&row.lifecycle).bind(row.revision).bind(row.created_at).bind(row.last_seen_at).bind(row.closed_at).bind(row.calls).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::McpDeltaOwnerCursors(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO mcp_delta_owner_cursors(owner_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5)").bind(&row.owner_id).bind(&row.space_id).bind(&row.history_incarnation).bind(row.acked_space_seq).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.mcp_delta_owner_cursors(owner_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5)").bind(&row.owner_id).bind(&row.space_id).bind(&row.history_incarnation).bind(row.acked_space_seq).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::McpDeltaSessionCursors(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5)").bind(&row.episode_id).bind(&row.space_id).bind(&row.history_incarnation).bind(row.acked_space_seq).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5)").bind(&row.episode_id).bind(&row.space_id).bind(&row.history_incarnation).bind(row.acked_space_seq).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AgentTelemetryConfig(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO agent_telemetry_config(singleton,detailed_enabled,compact_retention_days,detailed_retention_days,version,updated_at) VALUES($1,$2,$3,$4,$5,$6)").bind(row.singleton).bind(row.detailed_enabled).bind(row.compact_retention_days).bind(row.detailed_retention_days).bind(row.version).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.agent_telemetry_config(singleton,detailed_enabled,compact_retention_days,detailed_retention_days,version,updated_at) VALUES($1,$2,$3,$4,$5,$6)").bind(row.singleton).bind(row.detailed_enabled).bind(row.compact_retention_days).bind(row.detailed_retention_days).bind(row.version).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AgentCalls(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO agent_calls(call_id,owner_id,principal,agent,transport,request_id,episode_id,tool,effect,domain,started_at,finished_at,duration_ms,outcome,reason,input_bytes,output_bytes,summaries,fingerprint,projection_version,redacted,truncated,detail_capture_failed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)").bind(&row.call_id).bind(&row.owner_id).bind(&row.principal).bind(&row.agent).bind(&row.transport).bind(&row.request_id).bind(&row.episode_id).bind(&row.tool).bind(&row.effect).bind(&row.domain).bind(row.started_at).bind(row.finished_at).bind(row.duration_ms).bind(&row.outcome).bind(&row.reason).bind(row.input_bytes).bind(row.output_bytes).bind(&row.summaries).bind(&row.fingerprint).bind(row.projection_version).bind(row.redacted).bind(row.truncated).bind(row.detail_capture_failed).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.agent_calls(call_id,owner_id,principal,agent,transport,request_id,episode_id,tool,effect,domain,started_at,finished_at,duration_ms,outcome,reason,input_bytes,output_bytes,summaries,fingerprint,projection_version,redacted,truncated,detail_capture_failed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)").bind(&row.call_id).bind(&row.owner_id).bind(&row.principal).bind(&row.agent).bind(&row.transport).bind(&row.request_id).bind(&row.episode_id).bind(&row.tool).bind(&row.effect).bind(&row.domain).bind(row.started_at).bind(row.finished_at).bind(row.duration_ms).bind(&row.outcome).bind(&row.reason).bind(row.input_bytes).bind(row.output_bytes).bind(&row.summaries).bind(&row.fingerprint).bind(row.projection_version).bind(row.redacted).bind(row.truncated).bind(row.detail_capture_failed).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AgentCallDetails(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO agent_call_details(call_id,payload,created_at,expires_at) VALUES($1,$2,$3,$4)").bind(&row.call_id).bind(&row.payload).bind(row.created_at).bind(row.expires_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.agent_call_details(call_id,payload,created_at,expires_at) VALUES($1,$2,$3,$4)").bind(&row.call_id).bind(&row.payload).bind(row.created_at).bind(row.expires_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AgentRetrievals(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO agent_retrievals(retrieval_id,owner_id,principal,agent,call_id,tool,query_summary,filters,hit_refs,result_count,top_score,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(&row.retrieval_id).bind(&row.owner_id).bind(&row.principal).bind(&row.agent).bind(&row.call_id).bind(&row.tool).bind(&row.query_summary).bind(&row.filters).bind(&row.hit_refs).bind(row.result_count).bind(row.top_score).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.agent_retrievals(retrieval_id,owner_id,principal,agent,call_id,tool,query_summary,filters,hit_refs,result_count,top_score,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(&row.retrieval_id).bind(&row.owner_id).bind(&row.principal).bind(&row.agent).bind(&row.call_id).bind(&row.tool).bind(&row.query_summary).bind(&row.filters).bind(&row.hit_refs).bind(row.result_count).bind(row.top_score).bind(row.created_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::McpDedup(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO mcp_dedup(owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.owner).bind(&row.actor).bind(&row.request_key).bind(&row.request_hash).bind(&row.operation).bind(&row.safe_result).bind(&row.effect).bind(row.expires_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.mcp_dedup(owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&row.owner).bind(&row.actor).bind(&row.request_key).bind(&row.request_hash).bind(&row.operation).bind(&row.safe_result).bind(&row.effect).bind(row.expires_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AgentSchedules(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO agent_schedules(schedule_id,owner_id,space_id,project_folder_id,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)").bind(&row.schedule_id).bind(&row.owner_id).bind(&row.space_id).bind(&row.project_folder_id).bind(&row.cron_expr).bind(&row.timezone).bind(&row.approved_role).bind(&row.paused_reason).bind(row.write_class_mask).bind(&row.budgets).bind(&row.misfire_policy).bind(row.next_slot_utc_ms).bind(row.deleted_at).bind(row.revision).bind(row.created_at).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.agent_schedules(schedule_id,owner_id,space_id,project_folder_id,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)").bind(&row.schedule_id).bind(&row.owner_id).bind(&row.space_id).bind(&row.project_folder_id).bind(&row.cron_expr).bind(&row.timezone).bind(&row.approved_role).bind(&row.paused_reason).bind(row.write_class_mask).bind(&row.budgets).bind(&row.misfire_policy).bind(row.next_slot_utc_ms).bind(row.deleted_at).bind(row.revision).bind(row.created_at).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::AgentScheduleRuns(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&row.run_id).bind(&row.schedule_id).bind(row.slot_utc_ms).bind(row.lease_epoch).bind(&row.claim_request_hash).bind(row.claimed_schedule_revision).bind(row.reserved_next_slot).bind(&row.status).bind(row.started_at).bind(row.finished_at).bind(&row.safe_result).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&row.run_id).bind(&row.schedule_id).bind(row.slot_utc_ms).bind(row.lease_epoch).bind(&row.claim_request_hash).bind(row.claimed_schedule_revision).bind(row.reserved_next_slot).bind(&row.status).bind(row.started_at).bind(row.finished_at).bind(&row.safe_result).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ControlCommands(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO control_commands(owner,actor,command_key,request_hash,target,expected,result_revision,state,safe_result,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.owner).bind(&row.actor).bind(&row.command_key).bind(&row.request_hash).bind(&row.target).bind(row.expected).bind(row.result_revision).bind(&row.state).bind(&row.safe_result).bind(row.expires_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.control_commands(owner,actor,command_key,request_hash,target,expected,result_revision,state,safe_result,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.owner).bind(&row.actor).bind(&row.command_key).bind(&row.request_hash).bind(&row.target).bind(row.expected).bind(row.result_revision).bind(&row.state).bind(&row.safe_result).bind(row.expires_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::ControlOperations(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO control_operations(operation_id,command_key,kind,target_space,state,payload_hash,payload,canonical_receipt,next_action,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.operation_id).bind(&row.command_key).bind(&row.kind).bind(&row.target_space).bind(&row.state).bind(&row.payload_hash).bind(&row.payload).bind(&row.canonical_receipt).bind(&row.next_action).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.control_operations(operation_id,command_key,kind,target_space,state,payload_hash,payload,canonical_receipt,next_action,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&row.operation_id).bind(&row.command_key).bind(&row.kind).bind(&row.target_space).bind(&row.state).bind(&row.payload_hash).bind(&row.payload).bind(&row.canonical_receipt).bind(&row.next_action).bind(row.updated_at).execute(&mut **tx).await.map_err(database)?;
                }
            },
            Self::RevocationEvents(row) => match tx {
                Transaction::Sqlite(tx) => {
                    sqlx::query("INSERT INTO revocation_events(event_id,selector,reason,authority_version,committed_at,delivered_at,attempts) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.event_id).bind(&row.selector).bind(&row.reason).bind(row.authority_version).bind(row.committed_at).bind(row.delivered_at).bind(row.attempts).execute(&mut **tx).await.map_err(database)?;
                }
                Transaction::Postgres(tx) => {
                    sqlx::query("INSERT INTO v1_control.revocation_events(event_id,selector,reason,authority_version,committed_at,delivered_at,attempts) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&row.event_id).bind(&row.selector).bind(&row.reason).bind(row.authority_version).bind(row.committed_at).bind(row.delivered_at).bind(row.attempts).execute(&mut **tx).await.map_err(database)?;
                }
            },
        }
        Ok(())
    }
}
impl TargetTable {
    pub const ALL: &'static [Self] = &[
        Self::V1StorageEpoch,
        Self::Users,
        Self::UserOidcIdentities,
        Self::SpaceAdmission,
        Self::SpaceMembers,
        Self::Sessions,
        Self::OneTimeTokens,
        Self::Pats,
        Self::OauthClients,
        Self::OauthGrants,
        Self::OauthAuthCodes,
        Self::OauthRefreshFamilies,
        Self::OauthRefreshTokens,
        Self::OauthAccessTokens,
        Self::SecretKeyring,
        Self::OidcTransactions,
        Self::Credentials,
        Self::ProviderResources,
        Self::ProviderModels,
        Self::ProviderAttachments,
        Self::ProviderPreferences,
        Self::ProviderBudgetBuckets,
        Self::ProviderCallLog,
        Self::AbilityAvailability,
        Self::AbilityProjectBindings,
        Self::AbilityPreferences,
        Self::AbilityPlacementTrail,
        Self::Favorites,
        Self::ContextSets,
        Self::ContextSetAttachments,
        Self::ContextScopePins,
        Self::ContextOrder,
        Self::AgentEpisodes,
        Self::McpDeltaOwnerCursors,
        Self::McpDeltaSessionCursors,
        Self::AgentTelemetryConfig,
        Self::AgentCalls,
        Self::AgentCallDetails,
        Self::AgentRetrievals,
        Self::McpDedup,
        Self::AgentSchedules,
        Self::AgentScheduleRuns,
        Self::ControlCommands,
        Self::ControlOperations,
        Self::RevocationEvents,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::V1StorageEpoch => "v1_storage_epoch",
            Self::Users => "users",
            Self::UserOidcIdentities => "user_oidc_identities",
            Self::SpaceAdmission => "space_admission",
            Self::SpaceMembers => "space_members",
            Self::Sessions => "sessions",
            Self::OneTimeTokens => "one_time_tokens",
            Self::Pats => "pats",
            Self::OauthClients => "oauth_clients",
            Self::OauthGrants => "oauth_grants",
            Self::OauthAuthCodes => "oauth_auth_codes",
            Self::OauthRefreshFamilies => "oauth_refresh_families",
            Self::OauthRefreshTokens => "oauth_refresh_tokens",
            Self::OauthAccessTokens => "oauth_access_tokens",
            Self::SecretKeyring => "secret_keyring",
            Self::OidcTransactions => "oidc_transactions",
            Self::Credentials => "credentials",
            Self::ProviderResources => "provider_resources",
            Self::ProviderModels => "provider_models",
            Self::ProviderAttachments => "provider_attachments",
            Self::ProviderPreferences => "provider_preferences",
            Self::ProviderBudgetBuckets => "provider_budget_buckets",
            Self::ProviderCallLog => "provider_call_log",
            Self::AbilityAvailability => "ability_availability",
            Self::AbilityProjectBindings => "ability_project_bindings",
            Self::AbilityPreferences => "ability_preferences",
            Self::AbilityPlacementTrail => "ability_placement_trail",
            Self::Favorites => "favorites",
            Self::ContextSets => "context_sets",
            Self::ContextSetAttachments => "context_set_attachments",
            Self::ContextScopePins => "context_scope_pins",
            Self::ContextOrder => "context_order",
            Self::AgentEpisodes => "agent_episodes",
            Self::McpDeltaOwnerCursors => "mcp_delta_owner_cursors",
            Self::McpDeltaSessionCursors => "mcp_delta_session_cursors",
            Self::AgentTelemetryConfig => "agent_telemetry_config",
            Self::AgentCalls => "agent_calls",
            Self::AgentCallDetails => "agent_call_details",
            Self::AgentRetrievals => "agent_retrievals",
            Self::McpDedup => "mcp_dedup",
            Self::AgentSchedules => "agent_schedules",
            Self::AgentScheduleRuns => "agent_schedule_runs",
            Self::ControlCommands => "control_commands",
            Self::ControlOperations => "control_operations",
            Self::RevocationEvents => "revocation_events",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "table", content = "key", rename_all = "snake_case")]
pub enum TargetPosition {
    V1StorageEpoch {
        singleton: i64,
    },
    Users {
        user_id: String,
    },
    UserOidcIdentities {
        issuer: String,
        subject: String,
    },
    SpaceAdmission {
        space_id: String,
    },
    SpaceMembers {
        space_id: String,
        user_id: String,
    },
    Sessions {
        session_id: String,
    },
    OneTimeTokens {
        token_hash: Vec<u8>,
    },
    Pats {
        token_id: String,
    },
    OauthClients {
        client_id: String,
    },
    OauthGrants {
        grant_id: String,
    },
    OauthAuthCodes {
        code_hash: Vec<u8>,
    },
    OauthRefreshFamilies {
        family_id: String,
    },
    OauthRefreshTokens {
        token_id: String,
    },
    OauthAccessTokens {
        token_id: String,
    },
    SecretKeyring {
        key_id: String,
    },
    OidcTransactions {
        transaction_id: String,
    },
    Credentials {
        id: String,
    },
    ProviderResources {
        id: String,
    },
    ProviderModels {
        resource_id: String,
        model_id: String,
    },
    ProviderAttachments {
        id: String,
    },
    ProviderPreferences {
        owner_id: String,
        scope_kind: String,
        scope_id: String,
    },
    ProviderBudgetBuckets {
        budget_kind: String,
        budget_owner: String,
        window_start_ms: i64,
    },
    ProviderCallLog {
        call_id: String,
    },
    AbilityAvailability {
        placement: String,
        ability_id: String,
    },
    AbilityProjectBindings {
        placement: String,
        ability_id: String,
        target_space: String,
        project_id: String,
    },
    AbilityPreferences {
        owner_id: String,
        ability_id: String,
        placement: String,
    },
    AbilityPlacementTrail {
        source_placement: String,
        ability_id: String,
    },
    Favorites {
        owner_id: String,
        space_id: String,
        entity_kind: String,
        entity_id: String,
    },
    ContextSets {
        set_id: String,
    },
    ContextSetAttachments {
        set_id: String,
        target_kind: String,
        target_id: String,
    },
    ContextScopePins {
        owner_id: String,
        target_kind: String,
        target_id: String,
        note_space: String,
        note_id: String,
    },
    ContextOrder {
        owner_id: String,
        target_kind: String,
        target_id: String,
        entry_kind: String,
        entry_ref: String,
    },
    AgentEpisodes {
        episode_id: String,
    },
    McpDeltaOwnerCursors {
        owner_id: String,
        space_id: String,
    },
    McpDeltaSessionCursors {
        episode_id: String,
        space_id: String,
    },
    AgentTelemetryConfig {
        singleton: i64,
    },
    AgentCalls {
        call_id: String,
    },
    AgentCallDetails {
        call_id: String,
    },
    AgentRetrievals {
        retrieval_id: String,
    },
    McpDedup {
        owner: String,
        actor: String,
        request_key: String,
    },
    AgentSchedules {
        schedule_id: String,
    },
    AgentScheduleRuns {
        run_id: String,
    },
    ControlCommands {
        owner: String,
        actor: String,
        command_key: String,
    },
    ControlOperations {
        operation_id: String,
    },
    RevocationEvents {
        event_id: String,
    },
}
pub struct TargetPage {
    pub records: Vec<TargetRecord>,
    pub continuation: Option<TargetPosition>,
}
pub(crate) async fn read_page(
    tx: &mut Transaction,
    table: TargetTable,
    after: Option<TargetPosition>,
    limit: u16,
) -> Result<TargetPage, PortError> {
    if !(1..=200).contains(&limit) {
        return Err(crate::error::invalid(
            notarium_core::error::ValidationReason::InvalidLimit,
        ));
    }
    match table {
        TargetTable::V1StorageEpoch => {
            let chunk:super::RowChunk<V1StorageEpochRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,epoch_version,state,installation_id,receipt_sha256,receipt_json FROM v1_storage_epoch ORDER BY singleton LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,epoch_version,state,installation_id,receipt_sha256,receipt_json FROM v1_control.v1_storage_epoch ORDER BY singleton LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::V1StorageEpoch{singleton})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,epoch_version,state,installation_id,receipt_sha256,receipt_json FROM v1_storage_epoch WHERE singleton > $1 ORDER BY singleton LIMIT $2").bind(singleton).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,epoch_version,state,installation_id,receipt_sha256,receipt_json FROM v1_control.v1_storage_epoch WHERE singleton > $1 ORDER BY singleton LIMIT $2").bind(singleton).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::V1StorageEpoch {
                    singleton: row.singleton,
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::V1StorageEpoch).collect(),
                continuation,
            })
        }
        TargetTable::Users => {
            let chunk:super::RowChunk<UsersRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT user_id,username,email,display_name,password_hash,is_admin,disabled_at,personal_space_id,revision,auth_version,created_at FROM users ORDER BY user_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT user_id,username,email,display_name,password_hash,is_admin,disabled_at,personal_space_id,revision,auth_version,created_at FROM v1_control.users ORDER BY user_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::Users{user_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT user_id,username,email,display_name,password_hash,is_admin,disabled_at,personal_space_id,revision,auth_version,created_at FROM users WHERE user_id > $1 ORDER BY user_id LIMIT $2").bind(user_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT user_id,username,email,display_name,password_hash,is_admin,disabled_at,personal_space_id,revision,auth_version,created_at FROM v1_control.users WHERE user_id > $1 ORDER BY user_id LIMIT $2").bind(user_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::Users {
                    user_id: row.user_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::Users).collect(),
                continuation,
            })
        }
        TargetTable::UserOidcIdentities => {
            let chunk:super::RowChunk<UserOidcIdentitiesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT issuer,subject,user_id,created_at FROM user_oidc_identities ORDER BY issuer,subject LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT issuer,subject,user_id,created_at FROM v1_control.user_oidc_identities ORDER BY issuer,subject LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::UserOidcIdentities{issuer,subject})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT issuer,subject,user_id,created_at FROM user_oidc_identities WHERE (issuer,subject) > ($1,$2) ORDER BY issuer,subject LIMIT $3").bind(issuer).bind(subject).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT issuer,subject,user_id,created_at FROM v1_control.user_oidc_identities WHERE (issuer,subject) > ($1,$2) ORDER BY issuer,subject LIMIT $3").bind(issuer).bind(subject).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::UserOidcIdentities {
                    issuer: row.issuer.clone(),
                    subject: row.subject.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::UserOidcIdentities)
                    .collect(),
                continuation,
            })
        }
        TargetTable::SpaceAdmission => {
            let chunk:super::RowChunk<SpaceAdmissionRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,state,admission_epoch,revision FROM space_admission ORDER BY space_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,state,admission_epoch,revision FROM v1_control.space_admission ORDER BY space_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::SpaceAdmission{space_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,state,admission_epoch,revision FROM space_admission WHERE space_id > $1 ORDER BY space_id LIMIT $2").bind(space_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,state,admission_epoch,revision FROM v1_control.space_admission WHERE space_id > $1 ORDER BY space_id LIMIT $2").bind(space_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::SpaceAdmission {
                    space_id: row.space_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::SpaceAdmission).collect(),
                continuation,
            })
        }
        TargetTable::SpaceMembers => {
            let chunk:super::RowChunk<SpaceMembersRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,user_id,role,admission,revision,created_at FROM space_members ORDER BY space_id,user_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,user_id,role,admission,revision,created_at FROM v1_control.space_members ORDER BY space_id,user_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::SpaceMembers{space_id,user_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,user_id,role,admission,revision,created_at FROM space_members WHERE (space_id,user_id) > ($1,$2) ORDER BY space_id,user_id LIMIT $3").bind(space_id).bind(user_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT space_id,user_id,role,admission,revision,created_at FROM v1_control.space_members WHERE (space_id,user_id) > ($1,$2) ORDER BY space_id,user_id LIMIT $3").bind(space_id).bind(user_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::SpaceMembers {
                    space_id: row.space_id.clone(),
                    user_id: row.user_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::SpaceMembers).collect(),
                continuation,
            })
        }
        TargetTable::Sessions => {
            let chunk:super::RowChunk<SessionsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT session_id,token_hash,user_id,created_at,expires_at,last_used_at,revoked_at,auth_version FROM sessions ORDER BY session_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT session_id,token_hash,user_id,created_at,expires_at,last_used_at,revoked_at,auth_version FROM v1_control.sessions ORDER BY session_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::Sessions{session_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT session_id,token_hash,user_id,created_at,expires_at,last_used_at,revoked_at,auth_version FROM sessions WHERE session_id > $1 ORDER BY session_id LIMIT $2").bind(session_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT session_id,token_hash,user_id,created_at,expires_at,last_used_at,revoked_at,auth_version FROM v1_control.sessions WHERE session_id > $1 ORDER BY session_id LIMIT $2").bind(session_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::Sessions {
                    session_id: row.session_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::Sessions).collect(),
                continuation,
            })
        }
        TargetTable::OneTimeTokens => {
            let chunk:super::RowChunk<OneTimeTokensRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_hash,user_id,purpose,expires_at,used_at,created_at FROM one_time_tokens ORDER BY token_hash LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_hash,user_id,purpose,expires_at,used_at,created_at FROM v1_control.one_time_tokens ORDER BY token_hash LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OneTimeTokens{token_hash})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_hash,user_id,purpose,expires_at,used_at,created_at FROM one_time_tokens WHERE token_hash > $1 ORDER BY token_hash LIMIT $2").bind(token_hash).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_hash,user_id,purpose,expires_at,used_at,created_at FROM v1_control.one_time_tokens WHERE token_hash > $1 ORDER BY token_hash LIMIT $2").bind(token_hash).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OneTimeTokens {
                    token_hash: row.token_hash.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::OneTimeTokens).collect(),
                continuation,
            })
        }
        TargetTable::Pats => {
            let chunk:super::RowChunk<PatsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,secret_hash,user_id,name,scope,selected_spaces,expires_at,last_used_at,revoked_at,created_at FROM pats ORDER BY token_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,secret_hash,user_id,name,scope,selected_spaces,expires_at,last_used_at,revoked_at,created_at FROM v1_control.pats ORDER BY token_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::Pats{token_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,secret_hash,user_id,name,scope,selected_spaces,expires_at,last_used_at,revoked_at,created_at FROM pats WHERE token_id > $1 ORDER BY token_id LIMIT $2").bind(token_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,secret_hash,user_id,name,scope,selected_spaces,expires_at,last_used_at,revoked_at,created_at FROM v1_control.pats WHERE token_id > $1 ORDER BY token_id LIMIT $2").bind(token_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::Pats {
                    token_id: row.token_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::Pats).collect(),
                continuation,
            })
        }
        TargetTable::OauthClients => {
            let chunk:super::RowChunk<OauthClientsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT client_id,kind,redirect_uris,client_name,metadata_uri,metadata_digest,cache_expires_at,activated_at,created_at,last_seen_at FROM oauth_clients ORDER BY client_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT client_id,kind,redirect_uris,client_name,metadata_uri,metadata_digest,cache_expires_at,activated_at,created_at,last_seen_at FROM v1_control.oauth_clients ORDER BY client_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OauthClients{client_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT client_id,kind,redirect_uris,client_name,metadata_uri,metadata_digest,cache_expires_at,activated_at,created_at,last_seen_at FROM oauth_clients WHERE client_id > $1 ORDER BY client_id LIMIT $2").bind(client_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT client_id,kind,redirect_uris,client_name,metadata_uri,metadata_digest,cache_expires_at,activated_at,created_at,last_seen_at FROM v1_control.oauth_clients WHERE client_id > $1 ORDER BY client_id LIMIT $2").bind(client_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OauthClients {
                    client_id: row.client_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::OauthClients).collect(),
                continuation,
            })
        }
        TargetTable::OauthGrants => {
            let chunk:super::RowChunk<OauthGrantsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT grant_id,user_id,client_id,resource_uri,scope,selected_spaces,revoked_at,revision,created_at FROM oauth_grants ORDER BY grant_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT grant_id,user_id,client_id,resource_uri,scope,selected_spaces,revoked_at,revision,created_at FROM v1_control.oauth_grants ORDER BY grant_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OauthGrants{grant_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT grant_id,user_id,client_id,resource_uri,scope,selected_spaces,revoked_at,revision,created_at FROM oauth_grants WHERE grant_id > $1 ORDER BY grant_id LIMIT $2").bind(grant_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT grant_id,user_id,client_id,resource_uri,scope,selected_spaces,revoked_at,revision,created_at FROM v1_control.oauth_grants WHERE grant_id > $1 ORDER BY grant_id LIMIT $2").bind(grant_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OauthGrants {
                    grant_id: row.grant_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::OauthGrants).collect(),
                continuation,
            })
        }
        TargetTable::OauthAuthCodes => {
            let chunk:super::RowChunk<OauthAuthCodesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT code_hash,grant_id,client_id,redirect_uri,resource_uri,code_challenge,method,offline_access,expires_at,used_at,created_at FROM oauth_auth_codes ORDER BY code_hash LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT code_hash,grant_id,client_id,redirect_uri,resource_uri,code_challenge,method,offline_access,expires_at,used_at,created_at FROM v1_control.oauth_auth_codes ORDER BY code_hash LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OauthAuthCodes{code_hash})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT code_hash,grant_id,client_id,redirect_uri,resource_uri,code_challenge,method,offline_access,expires_at,used_at,created_at FROM oauth_auth_codes WHERE code_hash > $1 ORDER BY code_hash LIMIT $2").bind(code_hash).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT code_hash,grant_id,client_id,redirect_uri,resource_uri,code_challenge,method,offline_access,expires_at,used_at,created_at FROM v1_control.oauth_auth_codes WHERE code_hash > $1 ORDER BY code_hash LIMIT $2").bind(code_hash).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OauthAuthCodes {
                    code_hash: row.code_hash.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::OauthAuthCodes).collect(),
                continuation,
            })
        }
        TargetTable::OauthRefreshFamilies => {
            let chunk:super::RowChunk<OauthRefreshFamiliesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT family_id,grant_id,revoked_at,reason_code,created_at FROM oauth_refresh_families ORDER BY family_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT family_id,grant_id,revoked_at,reason_code,created_at FROM v1_control.oauth_refresh_families ORDER BY family_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OauthRefreshFamilies{family_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT family_id,grant_id,revoked_at,reason_code,created_at FROM oauth_refresh_families WHERE family_id > $1 ORDER BY family_id LIMIT $2").bind(family_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT family_id,grant_id,revoked_at,reason_code,created_at FROM v1_control.oauth_refresh_families WHERE family_id > $1 ORDER BY family_id LIMIT $2").bind(family_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OauthRefreshFamilies {
                    family_id: row.family_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::OauthRefreshFamilies)
                    .collect(),
                continuation,
            })
        }
        TargetTable::OauthRefreshTokens => {
            let chunk:super::RowChunk<OauthRefreshTokensRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,family_id,client_id,issued_at,expires_at,used_at,revoked_at,rotated_to FROM oauth_refresh_tokens ORDER BY token_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,family_id,client_id,issued_at,expires_at,used_at,revoked_at,rotated_to FROM v1_control.oauth_refresh_tokens ORDER BY token_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OauthRefreshTokens{token_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,family_id,client_id,issued_at,expires_at,used_at,revoked_at,rotated_to FROM oauth_refresh_tokens WHERE token_id > $1 ORDER BY token_id LIMIT $2").bind(token_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,family_id,client_id,issued_at,expires_at,used_at,revoked_at,rotated_to FROM v1_control.oauth_refresh_tokens WHERE token_id > $1 ORDER BY token_id LIMIT $2").bind(token_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OauthRefreshTokens {
                    token_id: row.token_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::OauthRefreshTokens)
                    .collect(),
                continuation,
            })
        }
        TargetTable::OauthAccessTokens => {
            let chunk:super::RowChunk<OauthAccessTokensRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,grant_id,family_id,refresh_id,resource_uri,scope,selected_spaces,issued_at,expires_at,revoked_at,last_used_at FROM oauth_access_tokens ORDER BY token_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,grant_id,family_id,refresh_id,resource_uri,scope,selected_spaces,issued_at,expires_at,revoked_at,last_used_at FROM v1_control.oauth_access_tokens ORDER BY token_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OauthAccessTokens{token_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,grant_id,family_id,refresh_id,resource_uri,scope,selected_spaces,issued_at,expires_at,revoked_at,last_used_at FROM oauth_access_tokens WHERE token_id > $1 ORDER BY token_id LIMIT $2").bind(token_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT token_id,token_hash,grant_id,family_id,refresh_id,resource_uri,scope,selected_spaces,issued_at,expires_at,revoked_at,last_used_at FROM v1_control.oauth_access_tokens WHERE token_id > $1 ORDER BY token_id LIMIT $2").bind(token_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OauthAccessTokens {
                    token_id: row.token_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::OauthAccessTokens)
                    .collect(),
                continuation,
            })
        }
        TargetTable::SecretKeyring => {
            let chunk:super::RowChunk<SecretKeyringRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM secret_keyring ORDER BY key_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM v1_control.secret_keyring ORDER BY key_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::SecretKeyring{key_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM secret_keyring WHERE key_id > $1 ORDER BY key_id LIMIT $2").bind(key_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM v1_control.secret_keyring WHERE key_id > $1 ORDER BY key_id LIMIT $2").bind(key_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::SecretKeyring {
                    key_id: row.key_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::SecretKeyring).collect(),
                continuation,
            })
        }
        TargetTable::OidcTransactions => {
            let chunk:super::RowChunk<OidcTransactionsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT transaction_id,state_hash,nonce_hash,flow_context_hash,key_id,issuer,client_id,redirect_uri,purpose,bound_user,browser_binding_hash,expires_at,consumed_at,created_at FROM oidc_transactions ORDER BY transaction_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT transaction_id,state_hash,nonce_hash,flow_context_hash,key_id,issuer,client_id,redirect_uri,purpose,bound_user,browser_binding_hash,expires_at,consumed_at,created_at FROM v1_control.oidc_transactions ORDER BY transaction_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::OidcTransactions{transaction_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT transaction_id,state_hash,nonce_hash,flow_context_hash,key_id,issuer,client_id,redirect_uri,purpose,bound_user,browser_binding_hash,expires_at,consumed_at,created_at FROM oidc_transactions WHERE transaction_id > $1 ORDER BY transaction_id LIMIT $2").bind(transaction_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT transaction_id,state_hash,nonce_hash,flow_context_hash,key_id,issuer,client_id,redirect_uri,purpose,bound_user,browser_binding_hash,expires_at,consumed_at,created_at FROM v1_control.oidc_transactions WHERE transaction_id > $1 ORDER BY transaction_id LIMIT $2").bind(transaction_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::OidcTransactions {
                    transaction_id: row.transaction_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::OidcTransactions)
                    .collect(),
                continuation,
            })
        }
        TargetTable::Credentials => {
            let chunk:super::RowChunk<CredentialsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,kind,secret,injection,disabled_at,rpm,tpm,consent_epoch,runtime_epoch,revision,created_at,updated_at FROM credentials ORDER BY id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,kind,secret,injection,disabled_at,rpm,tpm,consent_epoch,runtime_epoch,revision,created_at,updated_at FROM v1_control.credentials ORDER BY id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::Credentials{id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,kind,secret,injection,disabled_at,rpm,tpm,consent_epoch,runtime_epoch,revision,created_at,updated_at FROM credentials WHERE id > $1 ORDER BY id LIMIT $2").bind(id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,kind,secret,injection,disabled_at,rpm,tpm,consent_epoch,runtime_epoch,revision,created_at,updated_at FROM v1_control.credentials WHERE id > $1 ORDER BY id LIMIT $2").bind(id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::Credentials { id: row.id.clone() })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::Credentials).collect(),
                continuation,
            })
        }
        TargetTable::ProviderResources => {
            let chunk:super::RowChunk<ProviderResourcesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,default_model,timeouts,rpm,tpm,disabled_at,revision FROM provider_resources ORDER BY id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,default_model,timeouts,rpm,tpm,disabled_at,revision FROM v1_control.provider_resources ORDER BY id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ProviderResources{id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,default_model,timeouts,rpm,tpm,disabled_at,revision FROM provider_resources WHERE id > $1 ORDER BY id LIMIT $2").bind(id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,default_model,timeouts,rpm,tpm,disabled_at,revision FROM v1_control.provider_resources WHERE id > $1 ORDER BY id LIMIT $2").bind(id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::ProviderResources { id: row.id.clone() })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ProviderResources)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ProviderModels => {
            let chunk:super::RowChunk<ProviderModelsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision FROM provider_models ORDER BY resource_id,model_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision FROM v1_control.provider_models ORDER BY resource_id,model_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ProviderModels{resource_id,model_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision FROM provider_models WHERE (resource_id,model_id) > ($1,$2) ORDER BY resource_id,model_id LIMIT $3").bind(resource_id).bind(model_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision FROM v1_control.provider_models WHERE (resource_id,model_id) > ($1,$2) ORDER BY resource_id,model_id LIMIT $3").bind(resource_id).bind(model_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ProviderModels {
                    resource_id: row.resource_id.clone(),
                    model_id: row.model_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::ProviderModels).collect(),
                continuation,
            })
        }
        TargetTable::ProviderAttachments => {
            let chunk:super::RowChunk<ProviderAttachmentsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision FROM provider_attachments ORDER BY id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision FROM v1_control.provider_attachments ORDER BY id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ProviderAttachments{id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision FROM provider_attachments WHERE id > $1 ORDER BY id LIMIT $2").bind(id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision FROM v1_control.provider_attachments WHERE id > $1 ORDER BY id LIMIT $2").bind(id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::ProviderAttachments { id: row.id.clone() })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ProviderAttachments)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ProviderPreferences => {
            let chunk:super::RowChunk<ProviderPreferencesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,scope_kind,scope_id,resource_id,model_id,revision FROM provider_preferences ORDER BY owner_id,scope_kind,scope_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,scope_kind,scope_id,resource_id,model_id,revision FROM v1_control.provider_preferences ORDER BY owner_id,scope_kind,scope_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ProviderPreferences{owner_id,scope_kind,scope_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,scope_kind,scope_id,resource_id,model_id,revision FROM provider_preferences WHERE (owner_id,scope_kind,scope_id) > ($1,$2,$3) ORDER BY owner_id,scope_kind,scope_id LIMIT $4").bind(owner_id).bind(scope_kind).bind(scope_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,scope_kind,scope_id,resource_id,model_id,revision FROM v1_control.provider_preferences WHERE (owner_id,scope_kind,scope_id) > ($1,$2,$3) ORDER BY owner_id,scope_kind,scope_id LIMIT $4").bind(owner_id).bind(scope_kind).bind(scope_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ProviderPreferences {
                    owner_id: row.owner_id.clone(),
                    scope_kind: row.scope_kind.clone(),
                    scope_id: row.scope_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ProviderPreferences)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ProviderBudgetBuckets => {
            let chunk:super::RowChunk<ProviderBudgetBucketsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact FROM provider_budget_buckets ORDER BY budget_kind,budget_owner,window_start_ms LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact FROM v1_control.provider_budget_buckets ORDER BY budget_kind,budget_owner,window_start_ms LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ProviderBudgetBuckets{budget_kind,budget_owner,window_start_ms})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact FROM provider_budget_buckets WHERE (budget_kind,budget_owner,window_start_ms) > ($1,$2,$3) ORDER BY budget_kind,budget_owner,window_start_ms LIMIT $4").bind(budget_kind).bind(budget_owner).bind(window_start_ms).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact FROM v1_control.provider_budget_buckets WHERE (budget_kind,budget_owner,window_start_ms) > ($1,$2,$3) ORDER BY budget_kind,budget_owner,window_start_ms LIMIT $4").bind(budget_kind).bind(budget_owner).bind(window_start_ms).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::ProviderBudgetBuckets {
                        budget_kind: row.budget_kind.clone(),
                        budget_owner: row.budget_owner.clone(),
                        window_start_ms: row.window_start_ms,
                    })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ProviderBudgetBuckets)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ProviderCallLog => {
            let chunk:super::RowChunk<ProviderCallLogRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at FROM provider_call_log ORDER BY call_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at FROM v1_control.provider_call_log ORDER BY call_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ProviderCallLog{call_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at FROM provider_call_log WHERE call_id > $1 ORDER BY call_id LIMIT $2").bind(call_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at FROM v1_control.provider_call_log WHERE call_id > $1 ORDER BY call_id LIMIT $2").bind(call_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ProviderCallLog {
                    call_id: row.call_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ProviderCallLog)
                    .collect(),
                continuation,
            })
        }
        TargetTable::AbilityAvailability => {
            let chunk:super::RowChunk<AbilityAvailabilityRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,mode,enabled,revision FROM ability_availability ORDER BY placement,ability_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,mode,enabled,revision FROM v1_control.ability_availability ORDER BY placement,ability_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AbilityAvailability{placement,ability_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,mode,enabled,revision FROM ability_availability WHERE (placement,ability_id) > ($1,$2) ORDER BY placement,ability_id LIMIT $3").bind(placement).bind(ability_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,mode,enabled,revision FROM v1_control.ability_availability WHERE (placement,ability_id) > ($1,$2) ORDER BY placement,ability_id LIMIT $3").bind(placement).bind(ability_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AbilityAvailability {
                    placement: row.placement.clone(),
                    ability_id: row.ability_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AbilityAvailability)
                    .collect(),
                continuation,
            })
        }
        TargetTable::AbilityProjectBindings => {
            let chunk:super::RowChunk<AbilityProjectBindingsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,target_space,project_id FROM ability_project_bindings ORDER BY placement,ability_id,target_space,project_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,target_space,project_id FROM v1_control.ability_project_bindings ORDER BY placement,ability_id,target_space,project_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AbilityProjectBindings{placement,ability_id,target_space,project_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,target_space,project_id FROM ability_project_bindings WHERE (placement,ability_id,target_space,project_id) > ($1,$2,$3,$4) ORDER BY placement,ability_id,target_space,project_id LIMIT $5").bind(placement).bind(ability_id).bind(target_space).bind(project_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT placement,ability_id,target_space,project_id FROM v1_control.ability_project_bindings WHERE (placement,ability_id,target_space,project_id) > ($1,$2,$3,$4) ORDER BY placement,ability_id,target_space,project_id LIMIT $5").bind(placement).bind(ability_id).bind(target_space).bind(project_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::AbilityProjectBindings {
                        placement: row.placement.clone(),
                        ability_id: row.ability_id.clone(),
                        target_space: row.target_space.clone(),
                        project_id: row.project_id.clone(),
                    })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AbilityProjectBindings)
                    .collect(),
                continuation,
            })
        }
        TargetTable::AbilityPreferences => {
            let chunk:super::RowChunk<AbilityPreferencesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,ability_id,placement,enabled,revision FROM ability_preferences ORDER BY owner_id,ability_id,placement LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,ability_id,placement,enabled,revision FROM v1_control.ability_preferences ORDER BY owner_id,ability_id,placement LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AbilityPreferences{owner_id,ability_id,placement})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,ability_id,placement,enabled,revision FROM ability_preferences WHERE (owner_id,ability_id,placement) > ($1,$2,$3) ORDER BY owner_id,ability_id,placement LIMIT $4").bind(owner_id).bind(ability_id).bind(placement).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,ability_id,placement,enabled,revision FROM v1_control.ability_preferences WHERE (owner_id,ability_id,placement) > ($1,$2,$3) ORDER BY owner_id,ability_id,placement LIMIT $4").bind(owner_id).bind(ability_id).bind(placement).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AbilityPreferences {
                    owner_id: row.owner_id.clone(),
                    ability_id: row.ability_id.clone(),
                    placement: row.placement.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AbilityPreferences)
                    .collect(),
                continuation,
            })
        }
        TargetTable::AbilityPlacementTrail => {
            let chunk:super::RowChunk<AbilityPlacementTrailRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at FROM ability_placement_trail ORDER BY source_placement,ability_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at FROM v1_control.ability_placement_trail ORDER BY source_placement,ability_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AbilityPlacementTrail{source_placement,ability_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at FROM ability_placement_trail WHERE (source_placement,ability_id) > ($1,$2) ORDER BY source_placement,ability_id LIMIT $3").bind(source_placement).bind(ability_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at FROM v1_control.ability_placement_trail WHERE (source_placement,ability_id) > ($1,$2) ORDER BY source_placement,ability_id LIMIT $3").bind(source_placement).bind(ability_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::AbilityPlacementTrail {
                        source_placement: row.source_placement.clone(),
                        ability_id: row.ability_id.clone(),
                    })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AbilityPlacementTrail)
                    .collect(),
                continuation,
            })
        }
        TargetTable::Favorites => {
            let chunk:super::RowChunk<FavoritesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,entity_kind,entity_id,rank,created_at FROM favorites ORDER BY owner_id,space_id,entity_kind,entity_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,entity_kind,entity_id,rank,created_at FROM v1_control.favorites ORDER BY owner_id,space_id,entity_kind,entity_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::Favorites{owner_id,space_id,entity_kind,entity_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,entity_kind,entity_id,rank,created_at FROM favorites WHERE (owner_id,space_id,entity_kind,entity_id) > ($1,$2,$3,$4) ORDER BY owner_id,space_id,entity_kind,entity_id LIMIT $5").bind(owner_id).bind(space_id).bind(entity_kind).bind(entity_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,entity_kind,entity_id,rank,created_at FROM v1_control.favorites WHERE (owner_id,space_id,entity_kind,entity_id) > ($1,$2,$3,$4) ORDER BY owner_id,space_id,entity_kind,entity_id LIMIT $5").bind(owner_id).bind(space_id).bind(entity_kind).bind(entity_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::Favorites {
                    owner_id: row.owner_id.clone(),
                    space_id: row.space_id.clone(),
                    entity_kind: row.entity_kind.clone(),
                    entity_id: row.entity_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::Favorites).collect(),
                continuation,
            })
        }
        TargetTable::ContextSets => {
            let chunk:super::RowChunk<ContextSetsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,owner_id,home_space,name,note_refs,revision,created_at FROM context_sets ORDER BY set_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,owner_id,home_space,name,note_refs,revision,created_at FROM v1_control.context_sets ORDER BY set_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ContextSets{set_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,owner_id,home_space,name,note_refs,revision,created_at FROM context_sets WHERE set_id > $1 ORDER BY set_id LIMIT $2").bind(set_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,owner_id,home_space,name,note_refs,revision,created_at FROM v1_control.context_sets WHERE set_id > $1 ORDER BY set_id LIMIT $2").bind(set_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ContextSets {
                    set_id: row.set_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::ContextSets).collect(),
                continuation,
            })
        }
        TargetTable::ContextSetAttachments => {
            let chunk:super::RowChunk<ContextSetAttachmentsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,target_kind,target_id,target_space,owner_id,revision FROM context_set_attachments ORDER BY set_id,target_kind,target_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,target_kind,target_id,target_space,owner_id,revision FROM v1_control.context_set_attachments ORDER BY set_id,target_kind,target_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ContextSetAttachments{set_id,target_kind,target_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,target_kind,target_id,target_space,owner_id,revision FROM context_set_attachments WHERE (set_id,target_kind,target_id) > ($1,$2,$3) ORDER BY set_id,target_kind,target_id LIMIT $4").bind(set_id).bind(target_kind).bind(target_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT set_id,target_kind,target_id,target_space,owner_id,revision FROM v1_control.context_set_attachments WHERE (set_id,target_kind,target_id) > ($1,$2,$3) ORDER BY set_id,target_kind,target_id LIMIT $4").bind(set_id).bind(target_kind).bind(target_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::ContextSetAttachments {
                        set_id: row.set_id.clone(),
                        target_kind: row.target_kind.clone(),
                        target_id: row.target_id.clone(),
                    })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ContextSetAttachments)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ContextScopePins => {
            let chunk:super::RowChunk<ContextScopePinsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at FROM context_scope_pins ORDER BY owner_id,target_kind,target_id,note_space,note_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at FROM v1_control.context_scope_pins ORDER BY owner_id,target_kind,target_id,note_space,note_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ContextScopePins{owner_id,target_kind,target_id,note_space,note_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at FROM context_scope_pins WHERE (owner_id,target_kind,target_id,note_space,note_id) > ($1,$2,$3,$4,$5) ORDER BY owner_id,target_kind,target_id,note_space,note_id LIMIT $6").bind(owner_id).bind(target_kind).bind(target_id).bind(note_space).bind(note_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at FROM v1_control.context_scope_pins WHERE (owner_id,target_kind,target_id,note_space,note_id) > ($1,$2,$3,$4,$5) ORDER BY owner_id,target_kind,target_id,note_space,note_id LIMIT $6").bind(owner_id).bind(target_kind).bind(target_id).bind(note_space).bind(note_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ContextScopePins {
                    owner_id: row.owner_id.clone(),
                    target_kind: row.target_kind.clone(),
                    target_id: row.target_id.clone(),
                    note_space: row.note_space.clone(),
                    note_id: row.note_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ContextScopePins)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ContextOrder => {
            let chunk:super::RowChunk<ContextOrderRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision FROM context_order ORDER BY owner_id,target_kind,target_id,entry_kind,entry_ref LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision FROM v1_control.context_order ORDER BY owner_id,target_kind,target_id,entry_kind,entry_ref LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ContextOrder{owner_id,target_kind,target_id,entry_kind,entry_ref})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision FROM context_order WHERE (owner_id,target_kind,target_id,entry_kind,entry_ref) > ($1,$2,$3,$4,$5) ORDER BY owner_id,target_kind,target_id,entry_kind,entry_ref LIMIT $6").bind(owner_id).bind(target_kind).bind(target_id).bind(entry_kind).bind(entry_ref).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision FROM v1_control.context_order WHERE (owner_id,target_kind,target_id,entry_kind,entry_ref) > ($1,$2,$3,$4,$5) ORDER BY owner_id,target_kind,target_id,entry_kind,entry_ref LIMIT $6").bind(owner_id).bind(target_kind).bind(target_id).bind(entry_kind).bind(entry_ref).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ContextOrder {
                    owner_id: row.owner_id.clone(),
                    target_kind: row.target_kind.clone(),
                    target_id: row.target_id.clone(),
                    entry_kind: row.entry_kind.clone(),
                    entry_ref: row.entry_ref.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::ContextOrder).collect(),
                continuation,
            })
        }
        TargetTable::AgentEpisodes => {
            let chunk:super::RowChunk<AgentEpisodesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,owner_id,name,parent_id,active_role,project_space,project_folder,lifecycle,revision,created_at,last_seen_at,closed_at,calls FROM agent_episodes ORDER BY episode_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,owner_id,name,parent_id,active_role,project_space,project_folder,lifecycle,revision,created_at,last_seen_at,closed_at,calls FROM v1_control.agent_episodes ORDER BY episode_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AgentEpisodes{episode_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,owner_id,name,parent_id,active_role,project_space,project_folder,lifecycle,revision,created_at,last_seen_at,closed_at,calls FROM agent_episodes WHERE episode_id > $1 ORDER BY episode_id LIMIT $2").bind(episode_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,owner_id,name,parent_id,active_role,project_space,project_folder,lifecycle,revision,created_at,last_seen_at,closed_at,calls FROM v1_control.agent_episodes WHERE episode_id > $1 ORDER BY episode_id LIMIT $2").bind(episode_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AgentEpisodes {
                    episode_id: row.episode_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::AgentEpisodes).collect(),
                continuation,
            })
        }
        TargetTable::McpDeltaOwnerCursors => {
            let chunk:super::RowChunk<McpDeltaOwnerCursorsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,history_incarnation,acked_space_seq,updated_at FROM mcp_delta_owner_cursors ORDER BY owner_id,space_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,history_incarnation,acked_space_seq,updated_at FROM v1_control.mcp_delta_owner_cursors ORDER BY owner_id,space_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::McpDeltaOwnerCursors{owner_id,space_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,history_incarnation,acked_space_seq,updated_at FROM mcp_delta_owner_cursors WHERE (owner_id,space_id) > ($1,$2) ORDER BY owner_id,space_id LIMIT $3").bind(owner_id).bind(space_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner_id,space_id,history_incarnation,acked_space_seq,updated_at FROM v1_control.mcp_delta_owner_cursors WHERE (owner_id,space_id) > ($1,$2) ORDER BY owner_id,space_id LIMIT $3").bind(owner_id).bind(space_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::McpDeltaOwnerCursors {
                    owner_id: row.owner_id.clone(),
                    space_id: row.space_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::McpDeltaOwnerCursors)
                    .collect(),
                continuation,
            })
        }
        TargetTable::McpDeltaSessionCursors => {
            let chunk:super::RowChunk<McpDeltaSessionCursorsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,space_id,history_incarnation,acked_space_seq,updated_at FROM mcp_delta_session_cursors ORDER BY episode_id,space_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,space_id,history_incarnation,acked_space_seq,updated_at FROM v1_control.mcp_delta_session_cursors ORDER BY episode_id,space_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::McpDeltaSessionCursors{episode_id,space_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,space_id,history_incarnation,acked_space_seq,updated_at FROM mcp_delta_session_cursors WHERE (episode_id,space_id) > ($1,$2) ORDER BY episode_id,space_id LIMIT $3").bind(episode_id).bind(space_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT episode_id,space_id,history_incarnation,acked_space_seq,updated_at FROM v1_control.mcp_delta_session_cursors WHERE (episode_id,space_id) > ($1,$2) ORDER BY episode_id,space_id LIMIT $3").bind(episode_id).bind(space_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last()
                    .map(|row| TargetPosition::McpDeltaSessionCursors {
                        episode_id: row.episode_id.clone(),
                        space_id: row.space_id.clone(),
                    })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::McpDeltaSessionCursors)
                    .collect(),
                continuation,
            })
        }
        TargetTable::AgentTelemetryConfig => {
            let chunk:super::RowChunk<AgentTelemetryConfigRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,detailed_enabled,compact_retention_days,detailed_retention_days,version,updated_at FROM agent_telemetry_config ORDER BY singleton LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,detailed_enabled,compact_retention_days,detailed_retention_days,version,updated_at FROM v1_control.agent_telemetry_config ORDER BY singleton LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AgentTelemetryConfig{singleton})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,detailed_enabled,compact_retention_days,detailed_retention_days,version,updated_at FROM agent_telemetry_config WHERE singleton > $1 ORDER BY singleton LIMIT $2").bind(singleton).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT singleton,detailed_enabled,compact_retention_days,detailed_retention_days,version,updated_at FROM v1_control.agent_telemetry_config WHERE singleton > $1 ORDER BY singleton LIMIT $2").bind(singleton).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AgentTelemetryConfig {
                    singleton: row.singleton,
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AgentTelemetryConfig)
                    .collect(),
                continuation,
            })
        }
        TargetTable::AgentCalls => {
            let chunk:super::RowChunk<AgentCallsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,agent,transport,request_id,episode_id,tool,effect,domain,started_at,finished_at,duration_ms,outcome,reason,input_bytes,output_bytes,summaries,fingerprint,projection_version,redacted,truncated,detail_capture_failed FROM agent_calls ORDER BY call_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,agent,transport,request_id,episode_id,tool,effect,domain,started_at,finished_at,duration_ms,outcome,reason,input_bytes,output_bytes,summaries,fingerprint,projection_version,redacted,truncated,detail_capture_failed FROM v1_control.agent_calls ORDER BY call_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AgentCalls{call_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,agent,transport,request_id,episode_id,tool,effect,domain,started_at,finished_at,duration_ms,outcome,reason,input_bytes,output_bytes,summaries,fingerprint,projection_version,redacted,truncated,detail_capture_failed FROM agent_calls WHERE call_id > $1 ORDER BY call_id LIMIT $2").bind(call_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,owner_id,principal,agent,transport,request_id,episode_id,tool,effect,domain,started_at,finished_at,duration_ms,outcome,reason,input_bytes,output_bytes,summaries,fingerprint,projection_version,redacted,truncated,detail_capture_failed FROM v1_control.agent_calls WHERE call_id > $1 ORDER BY call_id LIMIT $2").bind(call_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AgentCalls {
                    call_id: row.call_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::AgentCalls).collect(),
                continuation,
            })
        }
        TargetTable::AgentCallDetails => {
            let chunk:super::RowChunk<AgentCallDetailsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,payload,created_at,expires_at FROM agent_call_details ORDER BY call_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,payload,created_at,expires_at FROM v1_control.agent_call_details ORDER BY call_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AgentCallDetails{call_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,payload,created_at,expires_at FROM agent_call_details WHERE call_id > $1 ORDER BY call_id LIMIT $2").bind(call_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT call_id,payload,created_at,expires_at FROM v1_control.agent_call_details WHERE call_id > $1 ORDER BY call_id LIMIT $2").bind(call_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AgentCallDetails {
                    call_id: row.call_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AgentCallDetails)
                    .collect(),
                continuation,
            })
        }
        TargetTable::AgentRetrievals => {
            let chunk:super::RowChunk<AgentRetrievalsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT retrieval_id,owner_id,principal,agent,call_id,tool,query_summary,filters,hit_refs,result_count,top_score,created_at FROM agent_retrievals ORDER BY retrieval_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT retrieval_id,owner_id,principal,agent,call_id,tool,query_summary,filters,hit_refs,result_count,top_score,created_at FROM v1_control.agent_retrievals ORDER BY retrieval_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AgentRetrievals{retrieval_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT retrieval_id,owner_id,principal,agent,call_id,tool,query_summary,filters,hit_refs,result_count,top_score,created_at FROM agent_retrievals WHERE retrieval_id > $1 ORDER BY retrieval_id LIMIT $2").bind(retrieval_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT retrieval_id,owner_id,principal,agent,call_id,tool,query_summary,filters,hit_refs,result_count,top_score,created_at FROM v1_control.agent_retrievals WHERE retrieval_id > $1 ORDER BY retrieval_id LIMIT $2").bind(retrieval_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AgentRetrievals {
                    retrieval_id: row.retrieval_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AgentRetrievals)
                    .collect(),
                continuation,
            })
        }
        TargetTable::McpDedup => {
            let chunk:super::RowChunk<McpDedupRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at FROM mcp_dedup ORDER BY owner,actor,request_key LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at FROM v1_control.mcp_dedup ORDER BY owner,actor,request_key LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::McpDedup{owner,actor,request_key})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at FROM mcp_dedup WHERE (owner,actor,request_key) > ($1,$2,$3) ORDER BY owner,actor,request_key LIMIT $4").bind(owner).bind(actor).bind(request_key).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at FROM v1_control.mcp_dedup WHERE (owner,actor,request_key) > ($1,$2,$3) ORDER BY owner,actor,request_key LIMIT $4").bind(owner).bind(actor).bind(request_key).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::McpDedup {
                    owner: row.owner.clone(),
                    actor: row.actor.clone(),
                    request_key: row.request_key.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::McpDedup).collect(),
                continuation,
            })
        }
        TargetTable::AgentSchedules => {
            let chunk:super::RowChunk<AgentSchedulesRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT schedule_id,owner_id,space_id,project_folder_id,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,revision,created_at,updated_at FROM agent_schedules ORDER BY schedule_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT schedule_id,owner_id,space_id,project_folder_id,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,revision,created_at,updated_at FROM v1_control.agent_schedules ORDER BY schedule_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AgentSchedules{schedule_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT schedule_id,owner_id,space_id,project_folder_id,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,revision,created_at,updated_at FROM agent_schedules WHERE schedule_id > $1 ORDER BY schedule_id LIMIT $2").bind(schedule_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT schedule_id,owner_id,space_id,project_folder_id,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,revision,created_at,updated_at FROM v1_control.agent_schedules WHERE schedule_id > $1 ORDER BY schedule_id LIMIT $2").bind(schedule_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AgentSchedules {
                    schedule_id: row.schedule_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows.into_iter().map(TargetRecord::AgentSchedules).collect(),
                continuation,
            })
        }
        TargetTable::AgentScheduleRuns => {
            let chunk:super::RowChunk<AgentScheduleRunsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result FROM agent_schedule_runs ORDER BY run_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result FROM v1_control.agent_schedule_runs ORDER BY run_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::AgentScheduleRuns{run_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result FROM agent_schedule_runs WHERE run_id > $1 ORDER BY run_id LIMIT $2").bind(run_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result FROM v1_control.agent_schedule_runs WHERE run_id > $1 ORDER BY run_id LIMIT $2").bind(run_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::AgentScheduleRuns {
                    run_id: row.run_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::AgentScheduleRuns)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ControlCommands => {
            let chunk:super::RowChunk<ControlCommandsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,command_key,request_hash,target,expected,result_revision,state,safe_result,expires_at FROM control_commands ORDER BY owner,actor,command_key LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,command_key,request_hash,target,expected,result_revision,state,safe_result,expires_at FROM v1_control.control_commands ORDER BY owner,actor,command_key LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ControlCommands{owner,actor,command_key})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,command_key,request_hash,target,expected,result_revision,state,safe_result,expires_at FROM control_commands WHERE (owner,actor,command_key) > ($1,$2,$3) ORDER BY owner,actor,command_key LIMIT $4").bind(owner).bind(actor).bind(command_key).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT owner,actor,command_key,request_hash,target,expected,result_revision,state,safe_result,expires_at FROM v1_control.control_commands WHERE (owner,actor,command_key) > ($1,$2,$3) ORDER BY owner,actor,command_key LIMIT $4").bind(owner).bind(actor).bind(command_key).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ControlCommands {
                    owner: row.owner.clone(),
                    actor: row.actor.clone(),
                    command_key: row.command_key.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ControlCommands)
                    .collect(),
                continuation,
            })
        }
        TargetTable::ControlOperations => {
            let chunk:super::RowChunk<ControlOperationsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT operation_id,command_key,kind,target_space,state,payload_hash,payload,canonical_receipt,next_action,updated_at FROM control_operations ORDER BY operation_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT operation_id,command_key,kind,target_space,state,payload_hash,payload,canonical_receipt,next_action,updated_at FROM v1_control.control_operations ORDER BY operation_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::ControlOperations{operation_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT operation_id,command_key,kind,target_space,state,payload_hash,payload,canonical_receipt,next_action,updated_at FROM control_operations WHERE operation_id > $1 ORDER BY operation_id LIMIT $2").bind(operation_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT operation_id,command_key,kind,target_space,state,payload_hash,payload,canonical_receipt,next_action,updated_at FROM v1_control.control_operations WHERE operation_id > $1 ORDER BY operation_id LIMIT $2").bind(operation_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::ControlOperations {
                    operation_id: row.operation_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::ControlOperations)
                    .collect(),
                continuation,
            })
        }
        TargetTable::RevocationEvents => {
            let chunk:super::RowChunk<RevocationEventsRow>=match after {
None=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM revocation_events ORDER BY event_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM v1_control.revocation_events ORDER BY event_id LIMIT $1").bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
Some(TargetPosition::RevocationEvents{event_id})=>match tx {
Transaction::Sqlite(tx)=>super::collect_rows(sqlx::query_as("SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM revocation_events WHERE event_id > $1 ORDER BY event_id LIMIT $2").bind(event_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
Transaction::Postgres(tx)=>super::collect_rows(sqlx::query_as("SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM v1_control.revocation_events WHERE event_id > $1 ORDER BY event_id LIMIT $2").bind(event_id).bind(i64::from(limit)+1).fetch(&mut **tx),limit,table).await?,
},
_=>return Err(crate::error::invalid(notarium_core::error::ValidationReason::ScopeMismatch)),
};
            let super::RowChunk { rows, has_more } = chunk;
            let continuation = if has_more {
                rows.last().map(|row| TargetPosition::RevocationEvents {
                    event_id: row.event_id.clone(),
                })
            } else {
                None
            };
            Ok(TargetPage {
                records: rows
                    .into_iter()
                    .map(TargetRecord::RevocationEvents)
                    .collect(),
                continuation,
            })
        }
    }
}
