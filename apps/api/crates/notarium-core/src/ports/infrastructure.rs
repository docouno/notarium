use super::{PortFuture, PortStream, context::*, types::*};
use crate::{
    DomainError, DomainResult, classes::ProviderPart, error::ValidationReason, ids::*, model::*,
    patch::*, receipt::*,
};
use std::time::Duration;

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
    pub used_tokens: u32,
}
pub trait EmbeddingProviderPort: Send + Sync {
    fn embed(
        &self,
        ctx: SpaceContext,
        request: EmbeddingRequest,
    ) -> PortFuture<'_, EmbeddingResult>;
}

#[derive(Clone, Debug)]
pub enum InterceptedPayload {
    EditNote {
        note: NoteId,
        body: BodyPatchPlan,
        header: HeaderMutation,
    },
    MoveBoardCard(MoveBoardCard),
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
#[derive(Debug)]
pub enum InterceptionResult {
    Applied(MutationReceiptToken),
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
    Grant(GrantId),
    OAuthGrant(OAuthGrantId),
    OAuthFamily(OAuthFamilyId),
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
#[derive(Clone, Debug)]
pub struct KeyCanary {
    pub key: KeyId,
    pub digest: ContentDigest,
    pub readable: bool,
}
#[derive(Clone, Debug)]
pub struct BackupWitness {
    pub installation: InstallationId,
    pub histories: Vec<ChangeCursor>,
    pub canaries: Vec<KeyCanary>,
}
#[derive(Clone, Debug)]
pub struct BackupSpool {
    pub artifact: ArtifactId,
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
