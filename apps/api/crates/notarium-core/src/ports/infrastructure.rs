use super::{PortFuture, PortStream, context::*, types::*};
use crate::{
    DomainError, DomainResult, classes::ProviderPart, error::ValidationReason, ids::*, model::*,
    patch::*, receipt::*, value::YamlValue,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

pub trait StructuralSnapshot: Send + Sync {
    fn cut(&self) -> &SnapshotCut;
    fn lookup(&self, note: &NoteId) -> Option<DenseNodeId>;
    fn note_id(&self, node: DenseNodeId) -> DomainResult<&NoteId>;
    fn folder_subtree(&self, folder: &FolderId) -> DomainResult<DenseNodeIter<'_>>;
    fn outgoing(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>>;
    fn incoming(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>>;
}
pub trait StructuralReadPort: Send + Sync {
    fn acquire_snapshot(
        &self,
        ctx: SpaceContext,
        causal: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>>;
    /// Current canonical fence, including class changes; never the pinned snapshot bit.
    fn is_live_visible(&self, ctx: &SpaceContext, note: &NoteId) -> DomainResult<bool>;
    /// Preserve request ordering, including absent/hidden rows.
    fn hydrate(
        &self,
        ctx: SpaceContext,
        cut: SnapshotCut,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>>;
}

#[derive(Clone, Debug)]
pub enum ChangeNotice {
    Advanced(ChangeCursor),
    Lagged { resume: ChangeCursor },
    SeedRequired { cutoff: ChangeCursor },
    PurgeResync { cutoff: ChangeCursor },
    Resync { scope: HistoryScope },
}
pub trait ChangeSubscription: Send {
    fn processed(&self) -> &ChangeCursor;
    fn next(&mut self) -> PortFuture<'_, Option<ChangeNotice>>;
    fn acknowledge(&mut self, processed: ChangeCursor) -> PortFuture<'_, ()>;
}
pub trait ChangeBroadcast: Send + Sync {
    fn subscribe(
        &self,
        ctx: MaintenanceContext,
        after: ChangeCursor,
    ) -> PortFuture<'_, Box<dyn ChangeSubscription>>;
    fn catch_up(
        &self,
        ctx: MaintenanceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult>;
}

#[derive(Clone, Debug)]
pub struct EmbeddingRequest {
    pub intent: CommandKey,
    pub model: ModelProfileId,
    pub provider: ProviderResourceId,
    pub project: Option<FolderRef>,
    pub chunks: Vec<ProviderPart>,
    pub declared_tokens: u32,
}
impl EmbeddingRequest {
    /// Provider owners check this before dispatch, then enforce their real model
    /// tokenizer and service budget. Declared tokens never replace actual counting.
    pub fn validate(&self) -> DomainResult<()> {
        let mut total = 0u32;
        for chunk in &self.chunks {
            if chunk.provider() != &self.provider || chunk.part().model() != &self.model {
                return Err(DomainError::validation(ValidationReason::ScopeMismatch));
            }
            total = total
                .checked_add(chunk.part().tokens())
                .ok_or_else(|| DomainError::validation(ValidationReason::TokenBudgetExceeded))?;
        }
        if total != self.declared_tokens {
            return Err(DomainError::validation(
                ValidationReason::TokenBudgetExceeded,
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct EmbeddingResult {
    pub model: ModelProfileId,
    pub dimension: u32,
    pub vectors: Vec<Result<Vec<f32>, DomainError>>,
    pub usage: super::provider::ProviderUsage,
}
pub trait EmbeddingProviderPort: Send + Sync {
    fn embed(
        &self,
        ctx: SpaceContext,
        request: EmbeddingRequest,
    ) -> PortFuture<'_, EmbeddingResult>;
}

/// Trusted planner capability minted on single-registration by composition root.
/// ```compile_fail
/// use notarium_core::ports::BoardPlannerAuthority;
/// let _: BoardPlannerAuthority = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone, Debug)]
pub struct BoardPlannerAuthority(Arc<()>);
impl BoardPlannerAuthority {
    pub fn admit() -> Self {
        Self(Arc::new(()))
    }
    pub fn matches(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoardGroupFieldKind {
    String,
    Bool,
    Number,
    Date,
    Timestamp,
    Scalar,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "placement", rename_all = "snake_case")]
pub enum SemanticPlacement {
    InGroup {
        group: GroupKey,
        predecessor: Option<NoteId>,
        successor: Option<NoteId>,
    },
    OutsideView,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluatedBoardRow {
    pub note: NoteId,
    pub expected_note: RevisionId,
    pub expected_rank: RankExpectation,
    pub base_order_binding: ContentDigest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluatedBoardGroup {
    pub group: GroupKey,
    pub rows: Vec<EvaluatedBoardRow>,
}

/// Non-deserializable semantic facts attested by the registered board planner.
/// ```compile_fail
/// use notarium_core::ports::BoardMoveFacts;
/// let _: BoardMoveFacts = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone, Debug)]
pub struct BoardMoveFacts {
    authority: BoardPlannerAuthority,
    scope: HistoryScope,
    cutoff: SpaceSeq,
    view: ViewRef,
    view_revision: RevisionId,
    schema_revision: Option<RevisionId>,
    descriptor_fingerprint: ContentDigest,
    group_field: String,
    group_field_kind: BoardGroupFieldKind,
    groups: Vec<EvaluatedBoardGroup>,
    before_placement: SemanticPlacement,
    base_order_binding: ContentDigest,
    after_eligible_in_group: bool,
}
impl PartialEq for BoardMoveFacts {
    fn eq(&self, other: &Self) -> bool {
        self.authority.matches(&other.authority)
            && self.scope == other.scope
            && self.cutoff == other.cutoff
            && self.view == other.view
            && self.view_revision == other.view_revision
            && self.schema_revision == other.schema_revision
            && self.descriptor_fingerprint == other.descriptor_fingerprint
            && self.group_field == other.group_field
            && self.group_field_kind == other.group_field_kind
            && self.groups == other.groups
            && self.before_placement == other.before_placement
            && self.base_order_binding == other.base_order_binding
            && self.after_eligible_in_group == other.after_eligible_in_group
    }
}
impl Eq for BoardMoveFacts {}

pub struct BoardMoveFactsSpec {
    pub scope: HistoryScope,
    pub cutoff: SpaceSeq,
    pub view: ViewRef,
    pub view_revision: RevisionId,
    pub schema_revision: Option<RevisionId>,
    pub descriptor_fingerprint: ContentDigest,
    pub group_field: String,
    pub group_field_kind: BoardGroupFieldKind,
    pub groups: Vec<EvaluatedBoardGroup>,
    pub before_placement: SemanticPlacement,
    pub base_order_binding: ContentDigest,
    pub after_eligible_in_group: bool,
}
impl BoardMoveFacts {
    pub fn attest(authority: &BoardPlannerAuthority, spec: BoardMoveFactsSpec) -> Self {
        Self {
            authority: authority.clone(),
            scope: spec.scope,
            cutoff: spec.cutoff,
            view: spec.view,
            view_revision: spec.view_revision,
            schema_revision: spec.schema_revision,
            descriptor_fingerprint: spec.descriptor_fingerprint,
            group_field: spec.group_field,
            group_field_kind: spec.group_field_kind,
            groups: spec.groups,
            before_placement: spec.before_placement,
            base_order_binding: spec.base_order_binding,
            after_eligible_in_group: spec.after_eligible_in_group,
        }
    }
    pub fn verify_authority(&self, expected: &BoardPlannerAuthority) -> DomainResult<()> {
        if self.authority.matches(expected) {
            Ok(())
        } else {
            Err(DomainError::validation(ValidationReason::InvalidAuthority))
        }
    }
    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }
    pub fn cutoff(&self) -> SpaceSeq {
        self.cutoff
    }
    pub fn view(&self) -> &ViewRef {
        &self.view
    }
    pub fn view_revision(&self) -> &RevisionId {
        &self.view_revision
    }
    pub fn schema_revision(&self) -> Option<&RevisionId> {
        self.schema_revision.as_ref()
    }
    pub fn descriptor_fingerprint(&self) -> ContentDigest {
        self.descriptor_fingerprint
    }
    pub fn group_field(&self) -> &str {
        &self.group_field
    }
    pub fn group_field_kind(&self) -> BoardGroupFieldKind {
        self.group_field_kind
    }
    pub fn groups(&self) -> &[EvaluatedBoardGroup] {
        &self.groups
    }
    pub fn before_placement(&self) -> &SemanticPlacement {
        &self.before_placement
    }
    pub fn base_order_binding(&self) -> ContentDigest {
        self.base_order_binding
    }
    pub fn after_eligible_in_group(&self) -> bool {
        self.after_eligible_in_group
    }
}

#[derive(Clone, Debug)]
pub struct PlannedNoteRestoration {
    pub note: NoteId,
    pub current_revision: RevisionId,
    pub restored_from_revision: Option<RevisionId>,
    pub planned_lifecycle: Lifecycle,
    pub planned_carrier: Option<String>,
    pub planned_fields: BTreeMap<String, Option<YamlValue>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoardViewRollbackFacts {
    pub view: ViewRef,
    pub view_revision: RevisionId,
    pub schema_revision: Option<RevisionId>,
    pub descriptor_fingerprint: ContentDigest,
    pub group_field: String,
    pub group_field_kind: BoardGroupFieldKind,
    pub groups: Vec<EvaluatedBoardGroup>,
    /// Post-restoration group membership for each eligible target (`None` = outside view).
    pub post_restore_membership: BTreeMap<NoteId, Option<GroupKey>>,
}

#[derive(Clone, Debug)]
pub struct RollbackBoardFacts {
    authority: BoardPlannerAuthority,
    scope: HistoryScope,
    cutoff: SpaceSeq,
    views: BTreeMap<ViewRef, BoardViewRollbackFacts>,
}
impl RollbackBoardFacts {
    pub fn attest(
        authority: &BoardPlannerAuthority,
        scope: HistoryScope,
        cutoff: SpaceSeq,
        views: BTreeMap<ViewRef, BoardViewRollbackFacts>,
    ) -> Self {
        Self {
            authority: authority.clone(),
            scope,
            cutoff,
            views,
        }
    }
    pub fn verify_authority(&self, expected: &BoardPlannerAuthority) -> DomainResult<()> {
        if self.authority.matches(expected) {
            Ok(())
        } else {
            Err(DomainError::validation(ValidationReason::InvalidAuthority))
        }
    }
    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }
    pub fn cutoff(&self) -> SpaceSeq {
        self.cutoff
    }
    pub fn views(&self) -> &BTreeMap<ViewRef, BoardViewRollbackFacts> {
        &self.views
    }
}

#[derive(Clone, Debug)]
pub struct RollbackBoardFactsRequest {
    pub cutoff: Option<SpaceSeq>,
    pub views: Vec<ViewRef>,
    pub eligible_notes: Vec<PlannedNoteRestoration>,
}

pub trait BoardMutationFactsProvider: Send + Sync {
    fn evaluate_move<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        cutoff: Option<SpaceSeq>,
        intent: MoveBoardCard,
    ) -> PortFuture<'a, BoardMoveFacts>;

    fn evaluate_rollback<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        request: RollbackBoardFactsRequest,
    ) -> PortFuture<'a, RollbackBoardFacts>;
}

#[derive(Clone, Debug)]
pub enum InterceptedPayload {
    EditNote {
        note: NoteId,
        plan: crate::patch::CarrierPatchPlan,
        body: BodyPatchPlan,
        header: HeaderMutation,
    },
    MoveBoardCard {
        card: MoveBoardCard,
        facts: Box<BoardMoveFacts>,
    },
    ExternalObservation {
        observation: ExternalObservation,
        body: BodyPatchPlan,
        header: HeaderMutation,
    },
}
#[derive(Clone, Debug)]
pub struct InterceptedMutation {
    pub context: SpaceContext,
    pub identity: CommandIdentity,
    pub preconditions: Preconditions,
    pub payload: InterceptedPayload,
}
/// Committed canonical outcome returned directly by a live room after it applies
/// an intercepted mutation, avoiding a redundant receipt read-back.
#[derive(Debug)]
pub enum InterceptedOutcome {
    NoteRevision(Committed<NoteRevision>),
    ExternalObservation(ExternalObservationResult),
    BoardMove(Committed<BoardMoveResult>),
}
#[derive(Debug)]
pub enum InterceptionResult {
    /// Exact canonical outcome applied by the live room.
    Applied(Box<InterceptedOutcome>),
    ClosedRoomReservation(ClosedRoomReservation),
    Conflict(DomainError),
}
#[derive(Debug)]
pub enum RollbackReservation {
    Closed(ClosedRoomReservation),
    SkippedRoomActive,
}
#[derive(Clone, Debug)]
pub enum FilenamePin {
    Unpinned,
    Pinned {
        note: NoteId,
        filename: String,
        lease: LeaseEpoch,
    },
}
pub trait LiveCollabInterceptor: Send + Sync {
    fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult>;
    fn reserve_rollback(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        identity: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation>;
    fn filename_pin(&self, ctx: SpaceContext, note: NoteId) -> PortFuture<'_, FilenamePin>;

    /// Non-blocking fast check returning a closed-room reservation when no local
    /// room slot is open, opening, or fenced. Returning `None` falls back to
    /// the full async `intercept` path.
    fn try_closed_room_reservation(
        &self,
        _scope: &HistoryScope,
        _note: &NoteId,
        _identity: &CommandIdentity,
    ) -> Option<ClosedRoomReservation> {
        None
    }

    /// Non-blocking hint indicating whether this interceptor currently tracks any
    /// active or opening room in `space`. Defaults to `true` (conservative).
    fn space_has_live_rooms(&self, _space: &SpaceId) -> bool {
        true
    }
}

/// Linear reservation. The runtime owns the lock that protects the corresponding fence.
#[derive(Debug)]
pub struct ClosedRoomReservation {
    note: NoteId,
    identity: CommandIdentity,
    epoch: LeaseEpoch,
}
#[derive(Debug)]
pub struct CommitPermit {
    pub note: NoteId,
    pub identity: CommandIdentity,
    pub epoch: LeaseEpoch,
}
/// Pure transition kernel; storage applies consume and commit under one fence lock.
#[derive(Debug)]
pub struct RoomFenceState {
    note: NoteId,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    active: bool,
}
impl RoomFenceState {
    pub fn new(note: NoteId, scope: HistoryScope, epoch: LeaseEpoch) -> Self {
        Self {
            note,
            scope,
            epoch,
            active: false,
        }
    }
    /// Current runtime fence, including epochs consumed by direct-write reservations.
    pub fn epoch(&self) -> LeaseEpoch {
        self.epoch
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn open(&mut self) -> DomainResult<()> {
        self.epoch = self.epoch.checked_next()?;
        self.active = true;
        Ok(())
    }
    pub fn close(&mut self) -> DomainResult<()> {
        self.epoch = self.epoch.checked_next()?;
        self.active = false;
        Ok(())
    }
    pub fn reserve(&self, identity: CommandIdentity) -> DomainResult<RollbackReservation> {
        self.scope.check(&identity.scope)?;
        if self.active {
            Ok(RollbackReservation::SkippedRoomActive)
        } else {
            Ok(RollbackReservation::Closed(ClosedRoomReservation {
                note: self.note.clone(),
                identity,
                epoch: self.epoch,
            }))
        }
    }
    pub fn consume(
        &mut self,
        reservation: ClosedRoomReservation,
        identity: &CommandIdentity,
    ) -> DomainResult<CommitPermit> {
        self.scope.check(&identity.scope)?;
        if self.active
            || self.epoch != reservation.epoch
            || self.note != reservation.note
            || identity != &reservation.identity
        {
            return Err(DomainError::validation(ValidationReason::SourceMismatch));
        }
        self.epoch = self.epoch.checked_next()?;
        Ok(CommitPermit {
            note: reservation.note,
            identity: reservation.identity,
            epoch: self.epoch,
        })
    }
}

#[derive(Clone, Debug)]
pub struct BoardDelta {
    pub scope: HistoryScope,
    pub seq: SpaceSeq,
    pub view: ViewRef,
    pub groups: Vec<GroupCount>,
    pub ranks: Vec<(NoteId, String)>,
}
#[derive(Clone, Debug)]
pub enum SpaceEventKind {
    Changed(Change),
    Board(BoardDelta),
    GraphSettled { generation: ProjectionGeneration },
    Job(ContentJob),
    Lifecycle(crate::auth::SpaceLifecycle),
    ResyncRequired,
}
#[derive(Clone, Debug)]
pub struct SpaceEvent {
    pub scope: HistoryScope,
    pub seq: SpaceSeq,
    pub kind: SpaceEventKind,
}
pub trait EventBusPort: Send + Sync {
    fn publish(&self, ctx: MaintenanceContext, event: SpaceEvent) -> PortFuture<'_, ()>;
    fn subscribe(
        &self,
        ctx: SpaceContext,
        after: ChangeCursor,
    ) -> PortFuture<'_, Box<dyn PortStream<SpaceEvent>>>;
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "target", rename_all = "snake_case")]
pub enum RevocationSelector {
    Principal(PrincipalId),
    Session(AuthSessionId),
    Credential(CredentialId),
    ProviderResource(ProviderResourceId),
    ProviderCall(RequestId),
    Schedule(ScheduleId),
    ScheduledRun(AgentRunId),
    Grant(GrantId),
    OAuthGrant(OAuthGrantId),
    OAuthFamily(OAuthFamilyId),
    OAuthAccess(CredentialTokenId),
    Membership {
        space: SpaceId,
        principal: PrincipalId,
    },
    Space(SpaceId),
}
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevocationReason {
    Logout,
    Expired,
    PermissionChanged,
    SpaceClosed,
    CredentialRemoved,
}
pub trait SessionRevocationPort: Send + Sync {
    /// Register only after locking and revalidating all selected database
    /// authorities. Keep the lease until the socket is closed; release it BEFORE
    /// acquiring a database transaction for usage settlement. The registry owner
    /// coordinates all service instances, cancels on lease/connection loss, and
    /// never admits a registration through an active mutation fence.
    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>>;
    /// Close matching admissions, cancel active calls, and wait for their leases
    /// to drop. The caller already holds database authority locks and retains
    /// this fence through COMMIT/ROLLBACK, including cancellation of its waiter.
    /// Selector batches are acquired atomically; implementations must not wait
    /// for database settlement while draining registrations.
    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>>;
    /// Recovery alone may claim an inactive call. Atomically return None when
    /// any live registration/fence exists for this call; otherwise close its
    /// admissions until the returned lease drops. Never cancel an active call
    /// merely because another process considers its database row old.
    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>>;
    /// Completion means all admitted registrations and run callbacks are invalidated.
    /// The service budget's request ID identifies the durable event and remains
    /// stable across retries, allowing the registry owner to deduplicate delivery.
    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        reason: RevocationReason,
    ) -> PortFuture<'_, ()>;
}

/// Loss of distributed registry authority invalidates a lease and cancels every
/// associated call. A local cache alone cannot implement this Cloud contract.
pub trait RevocationLease: Send {
    fn check(&self) -> Result<(), crate::error::PortError>;
}

#[derive(Clone, Copy, Debug)]
pub struct BackupBudget {
    pub deadline: Duration,
    pub retention: BackupRetentionBudget,
    pub max_spool_bytes: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct BackupProgress {
    pub elapsed: Duration,
    pub retention: BackupRetentionProgress,
    pub spool_bytes: u64,
}
#[derive(Clone, Copy, Debug)]
pub enum BackupRetentionBudget {
    SqliteWal { max_pinned_bytes: u64 },
    PostgresSnapshot { max_age: Duration },
}
#[derive(Clone, Copy, Debug)]
pub enum BackupRetentionProgress {
    SqliteWal { pinned_bytes: u64 },
    PostgresSnapshot { age: Duration },
}
impl BackupBudget {
    pub fn check(&self, progress: BackupProgress) -> DomainResult<()> {
        let retention_exceeded = match (self.retention, progress.retention) {
            (
                BackupRetentionBudget::SqliteWal { max_pinned_bytes },
                BackupRetentionProgress::SqliteWal { pinned_bytes },
            ) => pinned_bytes > max_pinned_bytes,
            (
                BackupRetentionBudget::PostgresSnapshot { max_age },
                BackupRetentionProgress::PostgresSnapshot { age },
            ) => age > max_age,
            _ => return Err(DomainError::validation(ValidationReason::ScopeMismatch)),
        };
        if progress.elapsed > self.deadline
            || retention_exceeded
            || progress.spool_bytes > self.max_spool_bytes
        {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyCanary {
    pub key: KeyId,
    pub generation: u64,
    pub active: bool,
    pub digest: ContentDigest,
    pub readable: bool,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupWitness {
    pub installation: InstallationId,
    pub schema_version: u32,
    pub histories: Vec<ChangeCursor>,
    pub canaries: Vec<KeyCanary>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupArtifactKind {
    SqliteSnapshotV1,
    PostgresSpoolV1,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupSpool {
    pub artifact: ArtifactId,
    pub kind: BackupArtifactKind,
    pub bytes: u64,
    pub digest: ContentDigest,
    pub witness: BackupWitness,
}

/// Dropping any phase must abort and release the resources it owns. Implementations
/// retain source snapshots until stable spool or abort, and CAS holds through copy.
pub trait BackupParticipantPort: Send + Sync {
    fn prepare(
        &self,
        ctx: MaintenanceContext,
        backup: BackupId,
        budget: BackupBudget,
    ) -> PortFuture<'_, Box<dyn PreparedBackup>>;
    /// Rebind restored Spaces before serving the materialized backup. Canonical
    /// requires each cutoff to equal that Space's stored head, including zero.
    /// Control clamps saved acknowledgements to those ceilings in the new histories.
    fn restore_cursors(
        &self,
        ctx: MaintenanceContext,
        restored: Vec<ChangeCursor>,
    ) -> PortFuture<'_, ()>;
}
pub trait PreparedBackup: Send {
    fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>>;
    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>>;
}
pub trait BackupHold: Send {
    fn witness(&self) -> &BackupWitness;
    /// Release after the external CAS copy. The coordinator may publish the paired
    /// backup once both participants acknowledge release. A lost hold invalidates the copy.
    fn release(self: Box<Self>) -> PortFuture<'static, ()>;
}
pub trait PausedBackup: Send {
    /// Must pin with a real database read; SELECT 1 alone is not a snapshot pin.
    fn open_cut(&mut self) -> PortFuture<'_, Box<dyn BackupSnapshot>>;
    /// Resume releases only the writer pause, not snapshots or the CAS hold.
    fn resume(self: Box<Self>) -> PortFuture<'static, ()>;
}
pub trait BackupSnapshot: Send {
    fn witness(&self) -> &BackupWitness;
    fn spool(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, BackupSpool>;
    fn close(self: Box<Self>) -> PortFuture<'static, ()>;
}
