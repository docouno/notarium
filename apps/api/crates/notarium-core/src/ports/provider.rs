//! Provider configuration and wire-independent conversation contracts.
use super::{PortFuture, context::*, control::*};
use crate::{
    DomainError, DomainResult,
    auth::SecretString,
    classes::{DocClass, ProviderCurrentContent, ProviderMessage, ProviderOrigin},
    error::ValidationReason,
    ids::*,
    model::FolderRef,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderWireKind {
    OpenaiCompatible,
    Ollama,
}

/// Model capabilities are explicit; a compatible URL does not infer a dialect.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderModelSpec {
    pub id: ModelProfileId,
    pub wire_name: String,
    pub kind: ProviderModelKind,
    pub accounting: TokenAccountingProfile,
    pub max_input_tokens: u32,
    pub max_output_tokens: u32,
    pub tools: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderModelKind {
    Completion,
    Embedding { dimension: u32 },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TokenAccountingProfile {
    /// Conservative UTF-8 scalar upper bound (`1/3`, `1/2`, or `1` token per 1-, 2-,
    /// or 3/4-byte scalar plus framing and tool-schema overhead; completion reserves
    /// `estimated_input + max_output_tokens`, embeddings reserve `max(declared_tokens, estimated)`).
    ConservativeModelCapV1,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreferenceModelKind {
    #[default]
    Completion,
    Embedding,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct ProviderLimits {
    pub requests_per_minute: Option<u32>,
    pub tokens_per_minute: Option<u64>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CredentialInjection {
    pub header: String,
    pub prefix: String,
}
#[derive(Debug)]
pub struct NewProviderCredential {
    pub id: CredentialId,
    pub name: String,
    pub injection: CredentialInjection,
    pub secret: SecretString,
    pub limits: ProviderLimits,
}
#[derive(Debug)]
pub struct UpdateProviderCredential {
    pub id: CredentialId,
    pub expected: ControlRevision,
    pub name: String,
    pub injection: CredentialInjection,
    pub secret: Option<SecretString>,
    pub limits: ProviderLimits,
    pub disabled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderCredentialInfo {
    pub id: CredentialId,
    pub name: String,
    pub injection: CredentialInjection,
    pub has_secret: bool,
    pub limits: ProviderLimits,
    pub disabled: bool,
    pub consent_epoch: u64,
    pub revision: ControlRevision,
}
#[derive(Debug)]
pub struct ProviderSecretHeader {
    pub name: String,
    pub value: SecretString,
}
#[derive(Debug)]
pub struct ProviderResourceSpec {
    pub id: ProviderResourceId,
    pub name: String,
    pub wire: ProviderWireKind,
    pub base_url: String,
    pub credential: Option<CredentialId>,
    pub headers: Vec<ProviderSecretHeader>,
    pub limits: ProviderLimits,
    pub timeout_ms: u32,
}
#[derive(Debug)]
pub struct UpdateProviderResource {
    pub expected: ControlRevision,
    pub spec: ProviderResourceSpec,
    pub disabled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderResourceInfo {
    pub id: ProviderResourceId,
    pub owner: PrincipalId,
    pub name: String,
    pub wire: ProviderWireKind,
    pub base_url: String,
    pub credential: Option<CredentialId>,
    /// Names only. Neither encrypted nor plaintext values are read back.
    pub secret_headers: Vec<String>,
    pub limits: ProviderLimits,
    pub timeout_ms: u32,
    pub disabled: bool,
    pub consent_epoch: u64,
    pub revision: ControlRevision,
    pub default_model: Option<ModelProfileId>,
}
#[derive(Clone, Debug)]
pub struct PutProviderModel {
    pub resource: ProviderResourceId,
    pub expected: ControlRevision,
    pub model: ProviderModelSpec,
    pub default: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderModelInfo {
    pub resource: ProviderResourceId,
    pub model: ProviderModelSpec,
    pub revision: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct DeleteProviderModel {
    pub resource: ProviderResourceId,
    pub model: ModelProfileId,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct DeleteProviderResource {
    pub resource: ProviderResourceId,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct DeleteProviderCredential {
    pub credential: CredentialId,
    pub expected: ControlRevision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderAttachmentTarget {
    Personal { owner: PrincipalId, space: SpaceId },
    Space(SpaceId),
    Project(FolderRef),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderDisclosure {
    pub classes: BTreeSet<DocClass>,
}
/// The interactive adapter must display the exact provider and disclosure and
/// verify explicit consent and CSRF before constructing this attestation.
#[derive(Clone, Debug)]
pub struct ProviderDisclosureConsent(ProviderDisclosure);
impl ProviderDisclosureConsent {
    pub fn attest_checked(disclosure: ProviderDisclosure) -> Self {
        Self(disclosure)
    }
    pub fn disclosure(&self) -> &ProviderDisclosure {
        &self.0
    }
}
#[derive(Clone, Debug)]
pub struct RequestProviderAttachment {
    pub id: RequestId,
    /// None creates a new attachment; reconsent uses the same ID and exact revision.
    pub expected: Option<ControlRevision>,
    pub resource: ProviderResourceId,
    /// Versions displayed with the provider before explicit confirmation.
    /// The attachment revision and sender account revision do not replace these.
    pub resource_consent_epoch: u64,
    pub credential_consent_epoch: Option<u64>,
    pub target: ProviderAttachmentTarget,
    pub consent: ProviderDisclosureConsent,
    pub expires_at_ms: Option<i64>,
}
#[derive(Clone, Debug)]
pub struct ApproveProviderAttachment {
    pub id: RequestId,
    pub expected: ControlRevision,
    pub resource_consent_epoch: u64,
    pub credential_consent_epoch: Option<u64>,
    pub consent: ProviderDisclosureConsent,
}
#[derive(Clone, Debug)]
pub struct RevokeProviderAttachment {
    pub id: RequestId,
    pub expected: ControlRevision,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderAttachmentState {
    Pending,
    Approved,
    Revoked,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderAttachmentInfo {
    pub id: RequestId,
    pub resource: ProviderResourceId,
    pub target: ProviderAttachmentTarget,
    pub disclosure: ProviderDisclosure,
    pub state: ProviderAttachmentState,
    pub resource_consent_epoch: u64,
    pub credential_consent_epoch: Option<u64>,
    pub expires_at_ms: Option<i64>,
    pub revision: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct ProviderAttachmentReview {
    pub attachment: ProviderAttachmentInfo,
    pub resource: ProviderResourceInfo,
    pub current_credential_consent_epoch: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct ProviderOfferQuery {
    /// Include offers for this exact active project alongside Space-wide offers.
    pub project: Option<FolderRef>,
    pub page: ControlPageRequest,
}
#[derive(Clone, Debug)]
pub struct SelectProvider {
    pub kind: PreferenceModelKind,
    pub resource: Option<ProviderResourceId>,
    pub model: Option<ModelProfileId>,
    pub project: Option<FolderRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderPreferenceScope {
    Personal,
    Space(SpaceId),
    Project(FolderRef),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetProviderPreference {
    pub scope: ProviderPreferenceScope,
    #[serde(default)]
    pub kind: PreferenceModelKind,
    pub resource: ProviderResourceId,
    pub model: ModelProfileId,
}

/// Trusted orchestration text (`System` instructions, scheduled `User` prompts,
/// or control-plane `Tool` outputs/errors). Never copy note, chat or ability
/// content into this wrapper; content bytes must retain `ProviderMessage` provenance.
#[derive(Clone)]
pub struct ProviderInstruction(String);
impl ProviderInstruction {
    pub fn from_orchestrator(text: String) -> DomainResult<Self> {
        if text.len() > 64 * 1024 || text.contains('\0') {
            return Err(DomainError::validation(ValidationReason::InvalidLimit));
        }
        Ok(Self(text))
    }
    pub fn text(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for ProviderInstruction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProviderInstruction([redacted])")
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionRole {
    System,
    User,
    Assistant,
    Tool,
}
/// Every non-orchestration content byte retains its classified provenance.
#[derive(Clone, Debug)]
pub struct CompletionMessage {
    pub role: CompletionRole,
    pub instruction: Option<ProviderInstruction>,
    pub parts: Vec<ProviderMessage>,
    pub tool_calls: Vec<ProviderToolCall>,
    pub result_for: Option<ProviderToolCallId>,
}
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProviderToolCallId(String);
impl ProviderToolCallId {
    pub fn new(value: String) -> DomainResult<Self> {
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        {
            return Err(DomainError::validation(ValidationReason::InvalidQuery));
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for ProviderToolCallId {
    type Error = DomainError;
    fn try_from(value: String) -> DomainResult<Self> {
        Self::new(value)
    }
}
impl From<ProviderToolCallId> for String {
    fn from(value: ProviderToolCallId) -> Self {
        value.0
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderToolCall {
    pub id: ProviderToolCallId,
    pub name: String,
    pub arguments: BTreeMap<String, serde_json::Value>,
}
impl fmt::Debug for ProviderToolCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderToolCall")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
/// A closed schema subset: no remote refs, regex programs or executable values.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ProviderToolSchema {
    String {
        choices: Vec<String>,
    },
    Number,
    Integer,
    Boolean,
    Null,
    Array {
        items: Box<ProviderToolSchema>,
        maximum: u32,
    },
    Object {
        properties: BTreeMap<String, ProviderToolSchema>,
        required: BTreeSet<String>,
    },
    Map {
        values: Box<ProviderToolSchema>,
    },
    AnyOf(Vec<ProviderToolSchema>),
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: ProviderToolSchema,
}
impl fmt::Debug for ProviderToolDefinition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderToolDefinition")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderUsage {
    Exact {
        input_tokens: u64,
        output_tokens: u64,
    },
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CompletionFinish {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderDeliveryState {
    Intent,
    Sending,
    Settled,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderOutcome {
    Completed,
    NotSent,
    Unknown,
    Failed,
    Cancelled,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderErrorCode {
    Unavailable,
    UnsupportedModel,
    Protocol,
    UpstreamAuthentication,
    UpstreamRateLimit,
    BudgetMismatch,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderCallStatus {
    pub id: RequestId,
    pub resource: ProviderResourceId,
    /// None identifies a non-inference connection check.
    pub model: Option<ModelProfileId>,
    pub state: ProviderDeliveryState,
    pub outcome: Option<ProviderOutcome>,
    pub usage: ProviderUsage,
    pub reserved_tokens: u64,
    pub diagnostic: Option<ProviderErrorCode>,
    pub created_at_ms: i64,
    pub settled_at_ms: Option<i64>,
}
#[derive(Clone, Debug)]
pub struct ProviderRecoveryPage {
    pub inspected: u16,
    pub settled: u16,
    pub continuation: Option<String>,
}
#[derive(Clone, Debug)]
pub struct CheckProviderConnection {
    pub resource: ProviderResourceId,
    pub intent: CommandKey,
}
#[derive(Clone, Debug)]
pub struct ProviderConnectionStatus {
    pub call: RequestId,
    pub reachable: bool,
}

pub trait ProviderAdminPort: Send + Sync {
    fn create_credential(
        &self,
        ctx: AccountContext,
        request: AccountMutation<NewProviderCredential>,
    ) -> PortFuture<'_, ControlCommit<ProviderCredentialInfo>>;
    fn update_credential(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UpdateProviderCredential>,
    ) -> PortFuture<'_, ControlCommit<ProviderCredentialInfo>>;
    fn delete_credential(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderCredential>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn list_credentials(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderCredentialInfo>>;
    fn create_resource(
        &self,
        ctx: AccountContext,
        request: AccountMutation<ProviderResourceSpec>,
    ) -> PortFuture<'_, ControlCommit<ProviderResourceInfo>>;
    fn update_resource(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UpdateProviderResource>,
    ) -> PortFuture<'_, ControlCommit<ProviderResourceInfo>>;
    fn delete_resource(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderResource>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn list_resources(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderResourceInfo>>;
    fn put_model(
        &self,
        ctx: AccountContext,
        request: AccountMutation<PutProviderModel>,
    ) -> PortFuture<'_, ControlCommit<ProviderModelInfo>>;
    fn delete_model(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderModel>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn list_models(
        &self,
        ctx: AccountContext,
        resource: ProviderResourceId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderModelInfo>>;
    fn request_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<RequestProviderAttachment>,
    ) -> PortFuture<'_, ControlCommit<ProviderAttachmentInfo>>;
    fn approve_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<ApproveProviderAttachment>,
    ) -> PortFuture<'_, ControlCommit<ProviderAttachmentInfo>>;
    fn revoke_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<RevokeProviderAttachment>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn list_attachments(
        &self,
        ctx: AccountContext,
        resource: ProviderResourceId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderAttachmentInfo>>;
    fn inspect_attachment(
        &self,
        ctx: AccountContext,
        attachment: RequestId,
    ) -> PortFuture<'_, ProviderAttachmentReview>;
    /// Current, approved shared offers visible before the sender's first consent.
    /// Pages are live keyset reads; each returned review must still be confirmed
    /// with its exact epochs. No personal attachments or secrets are included.
    fn list_offers(
        &self,
        ctx: SpaceContext,
        query: ProviderOfferQuery,
    ) -> PortFuture<'_, ControlPage<ProviderAttachmentReview>>;
    fn list_offer_models(
        &self,
        ctx: SpaceContext,
        offer: RequestId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderModelInfo>>;
    fn set_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetProviderPreference>,
    ) -> PortFuture<'_, ControlCommit<SetProviderPreference>>;
    fn inspect_call(
        &self,
        ctx: AccountContext,
        call: RequestId,
    ) -> PortFuture<'_, ProviderCallStatus>;
    fn check_connection(
        &self,
        ctx: AccountContext,
        request: CheckProviderConnection,
    ) -> PortFuture<'_, ProviderConnectionStatus>;
}

/// The canonical owner pins current metadata and excludes class, lifecycle and
/// provenance changes until dispatch releases this lease. Mutations may cancel
/// the supplied operation and wait for its lease to drop. No body crosses this port.
pub trait ProviderEgressLease: Send {
    /// Exactly one result per requested origin, in the original request order.
    fn current(&self) -> &[ProviderCurrentContent];
    /// The canonical owner verifies this active project and pins its lifecycle
    /// even when the call contains only trusted orchestration instructions.
    fn project(&self) -> Option<&FolderRef>;
    fn secondary_projects(&self) -> &[FolderRef];
    /// The transport received a successful final response head. A database
    /// read barrier can be released; keep revocation registration until close.
    fn mark_dispatched(&mut self);
    fn check(&self) -> DomainResult<()>;
}
#[derive(Clone, Debug)]
pub struct ProviderEgressRequest {
    pub origins: Vec<ProviderOrigin>,
    pub primary: crate::model::HistoryScope,
    pub project: Option<FolderRef>,
    pub secondary_projects: Vec<FolderRef>,
}
pub const MAX_PROVIDER_ORIGINS: usize = 4096;
pub const MAX_PROVIDER_SECONDARY_PROJECTS: usize = 64;
pub const MAX_PROVIDER_SOURCE_SPACES: usize = 64;

pub trait ProviderEgressCatalogPort: Send + Sync {
    fn acquire_egress(
        &self,
        ctx: AccountContext,
        request: ProviderEgressRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>>;
}
