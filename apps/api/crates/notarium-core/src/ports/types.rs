//! Shared typed payloads. Transport serialization and storage rows are separate.
use crate::{
    DomainError, DomainResult,
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
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageLimit(u16);
impl PageLimit {
    pub fn new(value: u16) -> DomainResult<Self> {
        if value == 0 || value > 200 {
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
}
#[derive(Clone, Debug)]
pub struct FolderPage {
    pub folder: FolderRef,
    pub page: Option<NoteSnapshot>,
    pub children: CursorPage<NoteListCard>,
}
#[derive(Clone, Debug)]
pub struct NoteQuery {
    pub folder: Option<FolderId>,
    pub recursive: bool,
    pub classes: BTreeSet<DocClass>,
    pub lifecycle: LifecycleMask,
    pub filter: FieldFilterAstV1,
    pub sort: SortSpec,
    pub limit: PageLimit,
}
#[derive(Clone, Debug)]
pub struct GetNote {
    pub note: NoteId,
    pub revision: Option<RevisionId>,
    pub causal: CausalBasis,
}
#[derive(Clone, Debug)]
pub struct CreateNote {
    pub note: NoteId,
    pub parent: Option<FolderId>,
    pub slug: String,
    pub class: DocClass,
    pub carrier: String,
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
    pub display_name: String,
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
#[derive(Clone, Debug, Eq, PartialEq)]
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
#[derive(Clone, Debug)]
pub struct AppendMemory {
    pub target: ResolvedMemoryTarget,
    pub text: String,
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
    pub expected_package_revision: Option<RevisionId>,
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
    pub head: ThreadEntrySeq,
    pub revision: RevisionId,
    pub tainted: bool,
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
    pub referenced_notes: Vec<NoteRef>,
    pub tainted: bool,
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
#[derive(Clone, Debug)]
pub enum QueueInputOutcome {
    Queued(Committed<QueuedInput>),
    Full { limit: u8 },
}
#[derive(Clone, Debug)]
pub struct QueuedInput {
    pub input: PendingInputId,
    pub position: u8,
}
#[derive(Clone, Debug)]
pub struct ConsumePending {
    pub thread: ChatThreadId,
    pub input: PendingInputId,
    pub expected_run: AgentRunId,
    pub current_leaf: ThreadEntrySeq,
}
#[derive(Clone, Debug)]
pub enum ConsumedPending {
    Appended(ChatEntry),
    AlreadyConsumed,
    BranchChanged {
        queued: ThreadEntrySeq,
        current: ThreadEntrySeq,
    },
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
