//! Shared typed payloads. Transport serialization and storage rows are separate.
use crate::{
    DomainError, DomainResult,
    auth::{AuthenticatedCredential, EngineAuthContext},
    classes::*,
    error::{Diagnostic, ValidationReason},
    ids::*,
    model::*,
    patch::*,
    query::*,
    receipt::*,
    value::*,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageLimit(u16);
impl PageLimit {
    pub const MAX: u16 = 200;

    pub fn new(value: u16) -> DomainResult<Self> {
        if value == 0 || value > Self::MAX {
            return Err(DomainError::validation(ValidationReason::InvalidLimit));
        }
        Ok(Self(value))
    }
    pub fn get(self) -> u16 {
        self.0
    }
}
#[derive(Clone, Debug)]
pub struct Mutation<T> {
    pub identity: CommandIdentity,
    pub preconditions: Preconditions,
    pub input: T,
}
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct Preconditions {
    pub revision: Option<RevisionId>,
    pub lease: Option<LeaseEpoch>,
    pub lineage: Option<LineageEpoch>,
}
#[derive(Clone, Debug)]
pub struct Committed<T> {
    pub value: T,
    pub receipt: MutationReceiptToken,
}
#[derive(Clone, Debug)]
pub struct NoteSnapshot {
    pub document: ClassifiedDocument,
    pub parent: Option<FolderId>,
    pub byte_size: u64,
    pub fields: BTreeMap<String, FieldObservation<FieldValue>>,
    pub diagnostics: Vec<Diagnostic>,
    pub provenance: Option<NoteProvenance>,
}
/// Metadata-only view of one committed note revision without hydrating its body blob.
#[derive(Clone, Debug)]
pub struct NoteMetadataSnapshot {
    pub metadata: ClassifiedMetadata,
    pub parent: Option<FolderId>,
    pub provenance: Option<NoteProvenance>,
}
/// Metadata associated with the exact note revision returned by the store.
#[derive(Clone, Debug)]
pub struct NoteProvenance {
    pub title: String,
    pub path: String,
    pub project: Option<FolderId>,
    pub principal: PrincipalId,
    pub modified_at: Timestamp,
    pub folder_page: bool,
}
#[derive(Clone, Debug)]
pub struct FolderSnapshot {
    pub reference: FolderRef,
    pub history: HistoryScope,
    pub revision: RevisionId,
    pub path: String,
    pub ancestor_folders: Vec<FolderId>,
    pub ancestor_revisions: Vec<RevisionId>,
    pub name: String,
    pub parent: Option<FolderId>,
    pub project: Option<FolderId>,
    pub cover_note: Option<NoteId>,
}
#[derive(Clone, Debug)]
pub struct ChildFolders {
    pub items: Vec<FolderSnapshot>,
    pub next: Option<FolderId>,
    pub cut_seq: SpaceSeq,
}
/// Maximum distinct values in each project bootstrap vocabulary list.
pub const MAX_PROJECT_BOOTSTRAP_VALUES: usize = 50;

/// Project bootstrap aggregates from a single authorized projection cut.
/// Producers apply current visibility to the counted notes and vocabulary.
#[derive(Clone, Debug)]
pub struct ProjectNoteCounts {
    pub project: FolderRef,
    pub cut: SnapshotCut,
    pub counts: BTreeMap<DocClass, u64>,
    /// Sorted distinct visible tags at the same cut as the counts, excluding
    /// encrypted notes. At most `MAX_PROJECT_BOOTSTRAP_VALUES` values.
    pub known_tags: Vec<String>,
    /// Sorted distinct visible agent-memory categories at that cut. At most
    /// `MAX_PROJECT_BOOTSTRAP_VALUES` values.
    pub known_categories: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct EnsureFolderPath {
    pub base: Option<FolderId>,
    pub path: String,
}
#[derive(Clone, Debug)]
pub struct NoteCard {
    pub document: SearchMetadata,
    pub title: String,
    pub path: String,
    pub preview: String,
}
/// Explicit listing metadata, including trash and encrypted-note identities.
/// Search/view/graph cards retain their stricter active metadata capability.
#[derive(Clone, Debug)]
pub struct NoteListCard {
    pub document: ListedDocument,
    pub title: String,
    pub path: String,
    pub tags: Vec<String>,
    pub view_type: Option<String>,
}
#[derive(Clone, Debug)]
pub struct FolderPage {
    pub folder: FolderRef,
    pub page: Option<NoteSnapshot>,
    pub children: CursorPage<NoteListCard>,
    pub total: u64,
}
#[derive(Clone, Debug)]
pub struct NoteQuery {
    pub folder: Option<FolderId>,
    pub recursive: bool,
    pub classes: BTreeSet<DocClass>,
    pub lifecycle: LifecycleMask,
    pub filter: FieldFilterAstV1,
    pub tag: Option<String>,
    pub sort: SortSpec,
    pub limit: PageLimit,
}
#[derive(Clone, Debug)]
pub struct GetNote {
    pub note: NoteId,
    pub revision: Option<RevisionId>,
    pub causal: CausalBasis,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateNote {
    pub note: NoteId,
    pub parent: Option<FolderId>,
    pub slug: String,
    pub class: DocClass,
    pub carrier: String,
    #[serde(default)]
    pub folder_page: bool,
}
#[derive(Clone, Debug)]
pub struct EditNote {
    pub note: NoteId,
    pub plan: CarrierPatchPlan,
}
#[derive(Clone, Debug)]
pub struct DeleteNote {
    pub note: NoteId,
    pub disposition: DeleteDisposition,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeleteDisposition {
    Trash,
    Restore,
    Purge,
}
#[derive(Clone, Debug)]
pub struct MintAndPurge {
    pub old_note: NoteId,
    pub expected_revision: RevisionId,
    pub new_note: NoteId,
    pub new_slug: Option<String>,
    pub encrypted_carrier: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintAndPurgeResult {
    pub old_note: NoteId,
    pub new_note: NoteRevision,
}
#[derive(Clone, Debug)]
pub struct MoveNote {
    pub note: NoteId,
    pub parent: Option<FolderId>,
    pub slug: String,
}
#[derive(Clone, Debug)]
pub struct RenameNote {
    pub note: NoteId,
    pub slug: String,
    pub title: Option<String>,
}
#[derive(Clone, Debug)]
pub struct MoveFolder {
    pub folder: FolderId,
    pub new_parent: Option<FolderId>,
}
#[derive(Clone, Debug)]
pub struct RenameFolder {
    pub folder: FolderId,
    pub name: String,
}
#[derive(Clone, Debug)]
pub struct RenameProject {
    pub folder: FolderId,
    pub name: String,
    pub display_name: Option<String>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NoteRevision {
    pub note: NoteId,
    pub revision: RevisionId,
}
#[derive(Clone, Debug)]
pub enum BatchItem {
    Create(CreateNote),
    Edit(EditNote),
    Delete(DeleteNote),
    Move(MoveNote),
}
#[derive(Clone, Debug)]
pub struct AcceptBatch {
    pub items: Vec<Mutation<BatchItem>>,
}
#[derive(Clone, Debug)]
pub struct BatchResult<T> {
    pub items: Vec<Result<Committed<T>, DomainError>>,
    pub committed_high_watermark: SpaceSeq,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "scope", content = "target", rename_all = "snake_case")]
pub enum MemoryTarget {
    User { owner: PrincipalId },
    Project { folder: FolderRef },
}
#[derive(Clone, Debug)]
pub struct ResolvedMemoryTarget {
    pub target: MemoryTarget,
    pub note: NoteRef,
    pub category: String,
}
/// An authorized memory target observed without materializing it.
#[derive(Clone, Debug)]
pub struct MemoryTargetSnapshot {
    pub resolved: ResolvedMemoryTarget,
    pub scope: HistoryScope,
    pub parent: FolderId,
    /// None represents a target that has yet to be created.
    pub revision: Option<RevisionId>,
}
#[derive(Clone, Debug)]
pub struct AppendMemory {
    pub target: ResolvedMemoryTarget,
    pub text: String,
    pub summary: Option<String>,
    pub mode: MemoryWriteMode,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryWriteMode {
    RequireExisting,
    CreateIfMissing,
    RequireAbsent,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryAppendOutcome {
    Created,
    Appended,
    Skipped,
}
#[derive(Clone, Debug)]
pub struct MemoryAppendResult {
    pub revision: NoteRevision,
    pub outcome: MemoryAppendOutcome,
    pub summary_updated: bool,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LinkTarget {
    Note(NoteId),
    Folder(FolderId),
    AuthoredName(String),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Link {
    pub source: NoteId,
    pub target: LinkTarget,
    pub relation: String,
    pub target_title: Option<String>,
}
#[derive(Clone, Debug)]
pub struct LinkBatch {
    pub items: Vec<Mutation<Link>>,
}
#[derive(Clone, Debug)]
pub struct AbilityFile {
    pub path: String,
    pub content: String,
    pub digest: ContentDigest,
}
#[derive(Clone, Debug)]
pub struct PublishAbilityPackage {
    pub ability: AbilityId,
    pub kind: AbilityKind,
    pub entrypoint: NoteId,
    pub files: Vec<AbilityFile>,
    pub attached_skills: Vec<super::AbilityRef>,
    pub expected_package_revision: Option<RevisionId>,
    pub expected_entrypoint_revision: Option<RevisionId>,
    pub requires_explicit_binding: bool,
}
#[derive(Clone, Debug)]
pub struct TrashAbilityPackage {
    pub ability: AbilityId,
    pub entrypoint: NoteId,
    pub package_revision: RevisionId,
}
#[derive(Clone, Debug)]
pub struct AbilityPackageRevision {
    pub ability: AbilityId,
    pub revision: RevisionId,
    pub manifest: BTreeMap<String, ContentDigest>,
}
#[derive(Clone, Debug)]
pub struct ReadAbilityResource {
    pub ability: AbilityId,
    pub package_revision: RevisionId,
    pub resource: AbilityResourceName,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", content = "revision", rename_all = "snake_case")]
pub enum RankExpectation {
    Absent,
    Existing(RevisionId),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssociatedBoardExpectation {
    pub view: ViewRef,
    pub note: NoteId,
    pub expected_rank: RankExpectation,
    pub expected_placement_revision: RevisionId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RestoredBoardRank {
    pub view: ViewRef,
    pub note: NoteId,
    pub group: GroupKey,
    pub rank: String,
    pub rank_revision: RevisionId,
    pub placement_revision: RevisionId,
}
#[derive(Clone, Debug)]
pub struct RollbackAgentRun {
    pub run: AgentRunId,
    pub expected_run_revision: RevisionId,
    pub expected_entities: Vec<NoteRevision>,
    pub associated_board_expectations: Vec<AssociatedBoardExpectation>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RollbackResult {
    pub restored: Vec<NoteRevision>,
    pub trashed: Vec<NoteRevision>,
    pub restored_ranks: Vec<RestoredBoardRank>,
    pub skipped_manual_edits: Vec<NoteId>,
    pub skipped_room_active: Vec<NoteId>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntityId {
    Note(NoteId),
    Folder(FolderId),
    Thread(ChatThreadId),
    Job(JobId),
    Ability(AbilityId),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangeKind {
    Create,
    Edit,
    Move,
    Rename,
    Trash,
    Restore,
    Purge,
    Redact,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandSeqRange {
    pub first_seq: SpaceSeq,
    pub last_seq: SpaceSeq,
}
impl CommandSeqRange {
    pub fn new(first_seq: SpaceSeq, last_seq: SpaceSeq) -> DomainResult<Self> {
        if first_seq == SpaceSeq::ZERO || first_seq > last_seq {
            return Err(DomainError::validation(ValidationReason::InvalidRange));
        }
        Ok(Self {
            first_seq,
            last_seq,
        })
    }
    pub fn contains(self, seq: SpaceSeq) -> bool {
        seq >= self.first_seq && seq <= self.last_seq
    }
    pub fn splits_cutoff(self, cutoff: SpaceSeq) -> bool {
        cutoff >= self.first_seq && cutoff < self.last_seq
    }
}
#[derive(Clone, Debug)]
pub struct Change {
    pub cursor: ChangeCursor,
    pub command_range: CommandSeqRange,
    pub entity: EntityId,
    pub kind: ChangeKind,
    pub revision: RevisionId,
    pub lifecycle: Lifecycle,
    pub class: Option<DocClass>,
    pub effect: MutationEffect,
    pub provenance: Option<NoteProvenance>,
}
#[derive(Clone, Debug)]
pub struct ChangePage {
    pub changes: Vec<Change>,
    pub next: ChangeCursor,
    pub safe_ack_end: SpaceSeq,
    pub cutoff: SpaceSeq,
    pub complete: bool,
}
#[derive(Clone, Debug)]
pub enum ChangeRead {
    Log {
        after: ChangeCursor,
        through: SpaceSeq,
        limit: PageLimit,
    },
    Seed {
        scope: HistoryScope,
        cutoff: Option<SpaceSeq>,
        limit: PageLimit,
    },
    ContinueSeed {
        cursor: SeedCursor,
    },
}
/// Notes precede threads; an empty note phase does not require a dummy NoteId.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SeedPosition {
    NotesAfter(NoteId),
    ThreadsAfter(ChatThreadId),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SeedCursor {
    pub cutoff: ChangeCursor,
    pub after: SeedPosition,
    pub limit: PageLimit,
}
#[derive(Clone, Debug)]
pub struct ChangeSeed {
    pub notes: Vec<NoteSnapshot>,
    pub threads: Vec<ChatThread>,
    pub cutoff: ChangeCursor,
    pub next: Option<SeedCursor>,
}
#[derive(Clone, Debug)]
pub enum ChangeReadResult {
    Log(ChangePage),
    Seed(ChangeSeed),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatThreadKind {
    Personal,
    SpaceGroup,
    KeeperLog,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatThread {
    pub id: ChatThreadId,
    pub space: SpaceId,
    pub kind: ChatThreadKind,
    pub owner: PrincipalId,
    pub project_folder: Option<FolderId>,
    pub title: String,
    pub head: ThreadEntrySeq,
    pub revision: RevisionId,
    pub tainted: bool,
    pub active_run: Option<AgentRunId>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChatEntryKind {
    Human,
    Model,
    Tool { call_id: CommandKey },
    Compaction,
    Redacted,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChatBody {
    Inline(String),
    Blob(ContentDigest),
    Redacted,
}
/// Canonical proof that a chat body exceeding 512 UTF-8 bytes has been staged in
/// this Space's CAS for the declared author; raw unowned digests cannot be attached.
/// ```compile_fail
/// use notarium_core::ports::StagedChatBlob;
/// let _: StagedChatBlob = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StagedChatBlob {
    space: SpaceId,
    owner: PrincipalId,
    digest: ContentDigest,
    byte_len: u64,
    lease: Option<[u8; 16]>,
}
impl StagedChatBlob {
    pub const INLINE_MAX_BYTES: u64 = 512;
    pub fn attest_canonical(
        space: SpaceId,
        owner: PrincipalId,
        digest: ContentDigest,
        byte_len: u64,
    ) -> DomainResult<Self> {
        if byte_len <= Self::INLINE_MAX_BYTES {
            return Err(DomainError::validation(ValidationReason::InvalidRange));
        }
        Ok(Self {
            space,
            owner,
            digest,
            byte_len,
            lease: None,
        })
    }
    /// Selects a specific durable staging reference; canonical verifies it on consumption.
    pub fn with_lease(mut self, lease: [u8; 16]) -> Self {
        self.lease = Some(lease);
        self
    }
    pub fn lease(&self) -> Option<[u8; 16]> {
        self.lease
    }
    pub fn space(&self) -> &SpaceId {
        &self.space
    }
    pub fn owner(&self) -> &PrincipalId {
        &self.owner
    }
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn byte_len(&self) -> u64 {
        self.byte_len
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChatInputBody {
    Text(String),
    Staged(StagedChatBlob),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatEntry {
    pub thread: ChatThreadId,
    pub seq: ThreadEntrySeq,
    pub parent: Option<ThreadEntrySeq>,
    pub is_chain_node: bool,
    pub depth: u32,
    pub ancestors: Vec<ThreadEntrySeq>,
    pub author: PrincipalId,
    pub run: Option<AgentRunId>,
    pub kind: ChatEntryKind,
    pub body: ChatBody,
    pub tainted: bool,
    pub referenced_notes: Vec<NoteRef>,
}
#[derive(Clone, Debug)]
pub struct ChatRead {
    pub thread: ChatThreadId,
    pub leaf: ThreadEntrySeq,
    pub before: Option<ThreadEntrySeq>,
    pub max_entries: PageLimit,
}
#[derive(Clone, Debug)]
pub struct ChatBranch {
    pub thread: ChatThread,
    pub entries: Vec<ChatEntry>,
    pub next_ancestor: Option<ThreadEntrySeq>,
}
/// Oldest retained prefix of the selected prompt, hydrated from its actual branch.
#[derive(Clone, Debug)]
pub struct ChatCompactionPrefix {
    pub branch: ChatBranch,
    pub contents: Vec<HydratedChatEntry>,
    /// A completion must summarize the prefix before using the unprocessed suffix.
    pub has_tail: bool,
}
/// A bounded batch of entry identities from one already selected branch.
#[derive(Clone, Debug)]
pub struct ChatContentRead {
    pub thread: ChatThreadId,
    pub leaf: ThreadEntrySeq,
    pub entries: Vec<ThreadEntrySeq>,
}
#[derive(Clone, Debug)]
pub struct HydratedChatEntry {
    pub seq: ThreadEntrySeq,
    pub content: CanonicalChatContent,
    pub interruption: Option<super::CompletionFinish>,
    pub tool_calls: Vec<super::ProviderToolCall>,
}
/// Immutable sources of a derived chat entry. Missing provenance on a legacy
/// derived entry cannot establish provider egress authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct ChatProvenance {
    pub origins: Vec<ProviderOrigin>,
    pub projects: Vec<FolderRef>,
    /// A prefix summary replaces history through this ancestor, inclusive.
    /// Older compactions without a boundary replace their entire prior context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compacts_through: Option<ThreadEntrySeq>,
}
impl ChatProvenance {
    pub const MAX_ORIGINS: usize = 256;
    pub const MAX_BYTES: usize = 256 * 1024;
}
#[derive(Clone, Debug)]
pub struct CreateChat {
    pub thread: ChatThreadId,
    pub kind: ChatThreadKind,
    pub owner: PrincipalId,
    pub project_folder: Option<FolderId>,
    pub title: String,
}
#[derive(Clone, Debug)]
pub struct ForkChat {
    pub thread: ChatThreadId,
    pub parent: ThreadEntrySeq,
}
#[derive(Clone, Debug)]
pub struct AppendChat {
    pub thread: ChatThreadId,
    pub parent: ThreadEntrySeq,
    pub kind: ChatEntryKind,
    pub body: ChatInputBody,
    pub tool_calls: Vec<super::ProviderToolCall>,
    pub provenance: Option<ChatProvenance>,
    /// Provider interruption retained with a partial Model body.
    pub interruption: Option<super::CompletionFinish>,
    pub proposed_diff: Option<String>,
    pub proposed_effect: Option<ConfirmedEffectKind>,
    pub referenced_notes: Vec<NoteRef>,
    pub tainted: bool,
}
impl AppendChat {
    pub const MAX_STRUCTURED_BODY_BYTES: usize = 256 * 1024;
}
#[derive(Clone, Debug)]
pub struct PendingChatInput {
    pub id: PendingInputId,
    pub thread: ChatThreadId,
    pub sender: PrincipalId,
    pub body: String,
    pub queued_base_leaf: ThreadEntrySeq,
    pub in_flight_run: AgentRunId,
    pub mentions_agent: bool,
}
/// Queue metadata visible to the supervisor. The pending body is transferred
/// inside the consume transaction, after the sender's live admission.
#[derive(Clone, Debug)]
pub struct QueuedChatInput {
    pub id: PendingInputId,
    pub sender: PrincipalId,
    pub queued_base_leaf: ThreadEntrySeq,
    pub in_flight_run: AgentRunId,
    pub mentions_agent: bool,
}
#[derive(Clone, Debug)]
pub enum QueueInputOutcome {
    Queued(Committed<QueuedInput>),
    Full { limit: u8 },
    Changed,
}
#[derive(Clone, Debug)]
pub struct QueuedInput {
    pub input: PendingInputId,
    pub position: u8,
}
/// A human input whose durable receipt covers both direct append and FIFO admission.
#[derive(Clone, Debug)]
pub struct SubmitUserChatInput {
    pub identity: CommandIdentity,
    pub id: PendingInputId,
    pub thread: ChatThreadId,
    pub expected_leaf: ThreadEntrySeq,
    pub body: String,
    pub mentions_agent: bool,
}
#[derive(Clone, Debug)]
pub enum SubmitUserChatOutcome {
    Appended(Committed<ChatEntry>),
    Queued(QueuedChatInput),
    Full { limit: u8 },
    Changed,
}
#[derive(Clone, Debug)]
pub struct ConsumePending {
    pub thread: ChatThreadId,
    pub input: PendingInputId,
    /// The run that was active when the input was queued.
    pub expected_run: AgentRunId,
    /// The current claim owned by the drainer. It may have advanced since enqueue.
    pub expected_active_run: AgentRunId,
    pub current_leaf: ThreadEntrySeq,
}
#[derive(Clone, Debug)]
pub enum ConsumedPending {
    Appended {
        entry: Box<ChatEntry>,
        intervening_human: bool,
    },
    AlreadyConsumed,
    BranchChanged {
        queued: ThreadEntrySeq,
        current: ThreadEntrySeq,
    },
}
#[derive(Clone, Debug)]
pub struct DismissPending {
    pub thread: ChatThreadId,
    pub input: PendingInputId,
}
#[derive(Clone, Debug)]
pub struct ClaimChatRun {
    pub thread: ChatThreadId,
    pub run: AgentRunId,
    pub expected_leaf: ThreadEntrySeq,
    pub previous_run: Option<AgentRunId>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaimChatRunOutcome {
    Claimed,
    Busy(AgentRunId),
    Changed,
}
#[derive(Clone, Debug)]
pub struct ChatRunRequest {
    pub thread: ChatThreadId,
    pub expected_run: AgentRunId,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinishChatRunOutcome {
    Cleared,
    Pending,
    Changed,
}
#[derive(Clone, Debug)]
pub struct ChatProposalRead {
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
}
#[derive(Clone, Debug)]
pub struct ChatProposalEntryWitness {
    pub seq: ThreadEntrySeq,
    pub revision: RevisionId,
    pub digest: ContentDigest,
}
/// Typed canonical effect family attested for a confirmed chat proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmedEffectKind {
    CreateNote,
    MoveNote,
    EditNote,
    RenameNote,
    TrashNote,
    Link,
    AppendMemory,
}
impl ConfirmedEffectKind {
    pub fn allows_canonical_command(self, kind: &str) -> bool {
        matches!(
            (self, kind),
            (Self::CreateNote, "create_note" | "ensure_folder_path")
                | (Self::MoveNote, "move_note" | "ensure_folder_path")
                | (Self::EditNote, "edit_note")
                | (Self::RenameNote, "rename_note")
                | (Self::TrashNote, "trash_note")
                | (Self::Link, "link")
                | (Self::AppendMemory, "append_memory")
        )
    }

    pub fn is_create(self) -> bool {
        self == Self::CreateNote
    }

    pub fn is_move(self) -> bool {
        self == Self::MoveNote
    }
}
/// The chat owner attests these facts after verifying the immutable carrier
/// pair. No request decoder can mint the witness.
///
/// ```compile_fail
/// use notarium_core::ports::ChatProposalWitness;
/// let _: ChatProposalWitness = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone)]
pub struct ChatProposalWitness {
    source: HistoryScope,
    owner: PrincipalId,
    credential: AuthenticatedCredential,
    thread: ChatThreadId,
    call_id: CommandKey,
    tool_name: String,
    effect_kind: ConfirmedEffectKind,
    model: ChatProposalEntryWitness,
    tool: ChatProposalEntryWitness,
}
impl ChatProposalWitness {
    /// Called by the canonical owner only after verifying authority and both
    /// carrier digests, including the tool call in the Model envelope.
    #[allow(clippy::too_many_arguments)]
    pub fn attest_canonical(
        source: HistoryScope,
        reader: &EngineAuthContext,
        thread: ChatThreadId,
        call_id: CommandKey,
        tool_name: String,
        effect_kind: ConfirmedEffectKind,
        model: ChatProposalEntryWitness,
        tool: ChatProposalEntryWitness,
    ) -> DomainResult<Self> {
        reader.authorize_proposal_read()?;
        let Some(
            credential @ (AuthenticatedCredential::Session(_)
            | AuthenticatedCredential::TrustedNone),
        ) = reader.credential()
        else {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority));
        };
        if model.seq == ThreadEntrySeq::ZERO || model.seq >= tool.seq {
            return Err(DomainError::validation(ValidationReason::InvalidState));
        }
        Ok(Self {
            source,
            owner: reader.principal().clone(),
            credential: credential.clone(),
            thread,
            call_id,
            tool_name,
            effect_kind,
            model,
            tool,
        })
    }
    pub fn authorize_writer(&self, writer: &EngineAuthContext) -> DomainResult<()> {
        if !writer.human_management()
            || writer.principal() != &self.owner
            || writer.credential() != Some(&self.credential)
        {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority));
        }
        if writer.taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted);
        }
        Ok(())
    }
    pub fn source(&self) -> &HistoryScope {
        &self.source
    }
    pub fn owner(&self) -> &PrincipalId {
        &self.owner
    }
    pub fn thread(&self) -> &ChatThreadId {
        &self.thread
    }
    pub fn call_id(&self) -> &CommandKey {
        &self.call_id
    }
    pub fn tool_name(&self) -> &str {
        &self.tool_name
    }
    pub fn effect_kind(&self) -> ConfirmedEffectKind {
        self.effect_kind
    }
    pub fn model(&self) -> &ChatProposalEntryWitness {
        &self.model
    }
    pub fn tool(&self) -> &ChatProposalEntryWitness {
        &self.tool
    }
}
impl fmt::Debug for ChatProposalWitness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChatProposalWitness")
            .field("source", &self.source)
            .field("thread", &self.thread)
            .field("call_id", &self.call_id)
            .finish_non_exhaustive()
    }
}
/// Trusted content from an unredacted tool entry and its immutable model call.
#[derive(Clone)]
pub struct CanonicalChatProposal {
    pub content: CanonicalChatContent,
    pub call_id: CommandKey,
    pub revision: RevisionId,
    pub digest: ContentDigest,
    pub model_entry: ThreadEntrySeq,
    pub model_revision: RevisionId,
    pub model_digest: ContentDigest,
    pub envelope: String,
    witness: ChatProposalWitness,
}
impl CanonicalChatProposal {
    pub fn from_canonical(
        content: CanonicalChatContent,
        envelope: String,
        witness: ChatProposalWitness,
    ) -> Self {
        Self {
            content,
            call_id: witness.call_id().clone(),
            revision: witness.tool().revision.clone(),
            digest: witness.tool().digest,
            model_entry: witness.model().seq,
            model_revision: witness.model().revision.clone(),
            model_digest: witness.model().digest,
            envelope,
            witness,
        }
    }
    pub fn witness(&self) -> &ChatProposalWitness {
        &self.witness
    }
}
impl fmt::Debug for CanonicalChatProposal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CanonicalChatProposal")
            .field("witness", &self.witness)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug)]
pub struct RedactChatEntry {
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
    pub expected_thread_revision: RevisionId,
}
#[derive(Clone, Debug)]
pub struct RedactedChat {
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
    pub parent: Option<ThreadEntrySeq>,
    pub invalidated_contexts: Vec<ThreadEntrySeq>,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct ViewRef {
    pub note: NoteId,
    pub key: ViewKey,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum GroupKey {
    Value(ScalarValue),
    Absent,
    EmptyList,
    Bad,
}
#[derive(Clone, Debug)]
pub struct ViewQuery {
    pub view: ViewRef,
    pub filter: FieldFilterAstV1,
    /// A client override. An absent value uses the view author's ordering.
    pub sort: Option<SortSpec>,
    pub group_by: Option<String>,
    pub limit: PageLimit,
}
#[derive(Clone, Debug)]
pub struct ViewRow {
    pub card: NoteCard,
    pub group: GroupKey,
    pub rank: Option<String>,
}
#[derive(Clone, Debug)]
pub struct ViewResult {
    pub rows: CursorPage<ViewRow>,
    pub groups: Vec<GroupCount>,
    pub effective_read: EffectiveReadId,
    pub view_revision: RevisionId,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupCount {
    pub group: GroupKey,
    pub count: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RankNeighbor {
    pub note: NoteId,
    pub expected_rank: RankExpectation,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveBoardCard {
    pub view: ViewRef,
    pub note: NoteId,
    pub group: GroupKey,
    pub before: Option<RankNeighbor>,
    pub after: Option<RankNeighbor>,
    pub fields: BTreeMap<String, Option<YamlValue>>,
    pub expected_note: RevisionId,
    pub expected_view: RevisionId,
    pub expected_rank: RankExpectation,
}
#[derive(Clone, Debug)]
pub struct BoardMoveResult {
    pub revision: NoteRevision,
    pub rank_revision: RevisionId,
    pub group: GroupKey,
    pub rank: String,
}
#[derive(Clone, Debug)]
pub enum GraphTier {
    Superclusters,
    Lens {
        /// Intersect cluster membership with the project, tags and field filter.
        /// The owner resolves this stable identity in the request's history scope.
        cluster: Option<ClusterId>,
        project: Option<FolderId>,
        tags: Vec<String>,
    },
    Neighborhood {
        note: NoteId,
        hops: u8,
    },
}
#[derive(Clone, Debug)]
pub struct GraphQuery {
    pub tier: GraphTier,
    pub filter: FieldFilterAstV1,
    pub causal: Option<CausalBasis>,
}
impl GraphQuery {
    pub fn validate(&self) -> DomainResult<()> {
        if matches!(self.tier,GraphTier::Neighborhood{hops,..} if !(1..=2).contains(&hops)) {
            return Err(DomainError::validation(ValidationReason::InvalidLimit));
        }
        Ok(())
    }
    pub fn node_limit(&self) -> usize {
        match self.tier {
            GraphTier::Superclusters => 500,
            _ => 2000,
        }
    }
}
/// Graph identities belong to the request/result history scope. Cluster identity
/// survives projection generations; it is neither a note nor a dense node index.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum GraphNodeId {
    Note(NoteId),
    Cluster(ClusterId),
}
#[derive(Clone, Debug)]
pub struct GraphNode {
    pub id: GraphNodeId,
    pub card: Option<NoteCard>,
    pub member_count: u64,
}
#[derive(Clone, Debug)]
pub struct GraphEdge {
    pub source: GraphNodeId,
    pub target: GraphNodeId,
    pub weight: f64,
}
#[derive(Clone, Debug)]
pub struct GraphResult {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub hidden_count: u64,
    pub truncated: bool,
    pub cut: SnapshotCut,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NoteLinkDirection {
    Outgoing,
    Incoming,
}
/// Outgoing authored links include unresolved targets. Incoming links are
/// emitted only when the source and focal target both pass visibility checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteLink {
    pub source: NoteId,
    pub ordinal: u32,
    pub raw_target: String,
    pub target: Option<NoteId>,
    pub resolved_tier: Option<u32>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteLinkCursor {
    pub cut: SnapshotCut,
    pub note: NoteId,
    pub direction: NoteLinkDirection,
    pub src_dense_id: u32,
    pub link_ord: u32,
}
#[derive(Clone, Debug)]
pub struct NoteLinkPage {
    pub cut: SnapshotCut,
    pub links: Vec<NoteLink>,
    pub next: Option<NoteLinkCursor>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatBacklink {
    pub thread: ChatThread,
    pub title: String,
    pub entry: ThreadEntrySeq,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatBacklinkCursor {
    pub scope: HistoryScope,
    pub generation: ProjectionGeneration,
    pub note: NoteId,
    pub after: (SpaceId, ChatThreadId, ThreadEntrySeq),
}
#[derive(Clone, Debug)]
pub struct ChatBacklinkPage {
    pub links: Vec<ChatBacklink>,
    /// A continuation refers only to a visible occurrence already returned.
    pub next: Option<ChatBacklinkCursor>,
}
#[derive(Clone, Debug)]
pub struct SearchQuery {
    pub text: String,
    pub filter: FieldFilterAstV1,
    pub classes: BTreeSet<DocClass>,
    pub folder: Option<FolderId>,
    pub causal: CausalBasis,
    pub include_chats: bool,
    pub top_k: PageLimit,
    pub model: Option<ModelProfileId>,
}
#[derive(Clone, Debug)]
pub struct RecallQuery {
    pub query: SearchQuery,
    pub graph_depth: u8,
    pub token_budget: u32,
    /// Maximum sum of admitted chunk tokens from one note.
    pub max_per_source: Option<u16>,
}
impl RecallQuery {
    pub const MAX_GRAPH_DEPTH: u8 = 3;
}
#[derive(Clone, Debug)]
pub struct SearchHit {
    pub card: NoteCard,
    pub score: f64,
    pub chunks: Vec<SearchPart>,
}
#[derive(Clone, Debug)]
pub struct ChatSearchHit {
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
    pub kind: ChatThreadKind,
    pub project_folder: Option<FolderId>,
    pub author: PrincipalId,
    pub snippet: String,
    pub score: f64,
}
#[derive(Clone, Debug)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub chat_hits: Vec<ChatSearchHit>,
    pub cut: SnapshotCut,
    pub degraded: Option<SearchDegradation>,
    pub truncated: bool,
}
#[derive(Clone, Copy, Debug)]
pub enum SearchDegradation {
    EmbeddingsPending,
    ModelUnavailable,
    ProviderUnavailable,
    BudgetExceeded,
}

#[derive(Clone, Debug)]
pub enum ContentJobKind {
    Import { artifact: ArtifactId },
    Export { notes: Vec<NoteId>, encrypted: bool },
    Backup,
    Restore { artifact: ArtifactId },
    Reindex,
    Reembed { model: ModelProfileId },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug)]
pub struct ContentJob {
    pub id: JobId,
    pub kind: ContentJobKind,
    pub state: JobState,
    pub completed_units: u64,
    pub total_units: Option<u64>,
    pub lease: LeaseEpoch,
    pub artifacts: Vec<ArtifactId>,
}
#[derive(Clone, Debug)]
pub struct JobQuery {
    pub states: Vec<JobState>,
    pub limit: PageLimit,
}
#[derive(Clone, Debug)]
pub struct CancelJob {
    pub job: JobId,
    pub expected_lease: LeaseEpoch,
}
#[derive(Clone, Debug)]
pub enum ObservedContent {
    Carrier(String),
    Planned(CarrierPatchPlan),
}
#[derive(Clone, Debug)]
pub struct ExternalObservation {
    pub note: NoteId,
    pub observed_digest: ContentDigest,
    pub base_revision: RevisionId,
    pub disk_identity: ContentDigest,
    pub content: ObservedContent,
}
#[derive(Clone, Debug)]
pub enum ExternalObservationResult {
    Committed(Committed<NoteRevision>),
    NoChange { revision: RevisionId },
    Conflict { current: RevisionId },
}
