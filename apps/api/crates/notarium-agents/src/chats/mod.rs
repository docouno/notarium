//! Detached chat turns and their canonical branch ownership.

pub(crate) mod prompt;
mod queue;
mod run;
pub mod stream;

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use notarium_core::{
    DomainError,
    auth::{ChatAudience, EngineAuthContext, PrincipalKind, ProposalHumanAccess},
    classes::DocClass,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope},
    ports::{schedules::RunLimits, *},
    receipt::CommandIdentity,
};
use tokio::{
    sync::{Mutex as AsyncMutex, oneshot},
    time::Instant,
};

use crate::{
    mcp::{ToolRegistry, derive_digest, derive_key},
    revocation::{
        PendingCredential, PendingCredentialKey, RevocationHub, RunRevocationLease,
        ViewerRevocationLease,
    },
};
use stream::{RunFailure, StepStreamBuffer, StepSubscription, StreamCursor, StreamRead};

const MAINTENANCE_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChatRunOptions {
    pub provider: Option<ProviderResourceId>,
    pub model: Option<ModelProfileId>,
    pub role: Option<String>,
    pub limits: RunLimits,
}

#[derive(Clone, Debug)]
pub struct StartChatRun {
    pub scope: HistoryScope,
    pub thread: ChatThreadId,
    pub expected_leaf: ThreadEntrySeq,
    pub options: ChatRunOptions,
}

pub struct ChatSubmission {
    pub outcome: SubmitUserChatOutcome,
    pub run: Option<AgentRunId>,
}

pub struct ChatSubscription {
    stream: StepSubscription,
    cancellation: Cancellation,
    expires_at: Option<Instant>,
    _revocation: ViewerRevocationLease,
    _buffer: Arc<StepStreamBuffer>,
}

impl ChatSubscription {
    pub async fn next(&mut self) -> StreamRead {
        let next = tokio::select! {
            biased;
            () = self.cancellation.cancelled() => return StreamRead::Closed,
            () = async {
                match self.expires_at {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            } => return StreamRead::Closed,
            next = self.stream.next() => next,
        };
        if self.cancellation.is_cancelled()
            || self
                .expires_at
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            StreamRead::Closed
        } else {
            next
        }
    }
}

/// The composition attests that a locally opened data root has one live writer.
pub struct ExclusiveDataRoot {
    _verified: (),
}

impl ExclusiveDataRoot {
    pub fn attest_open_writer() -> Self {
        Self { _verified: () }
    }
}

#[derive(Clone, Debug)]
pub struct RunOwnershipRequest {
    pub scope: HistoryScope,
    pub thread: ChatThreadId,
    pub run: AgentRunId,
    pub transition: RunOwnershipTransition,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunOwnershipTransition {
    Vacant,
    Handoff { previous: AgentRunId },
    Recover { previous: AgentRunId },
}

/// Implementations register with the live Space writer and its shared revocation
/// authority. Each serving instance's hub participates in the same revocation
/// fences for runs, pending senders, and viewers. A handoff may temporarily
/// register both turns under the current writer. Recovery requires a fenced
/// predecessor. Loss of writer ownership cancels the supplied token and closes
/// the old writer's viewer streams, including retained completed runs.
pub trait ClusterRunAuthority: SessionRevocationPort {
    /// Admit a durable chat write on the instance that owns the thread's run,
    /// or on the Space writer when the thread is idle. Cancel the command if
    /// this route loses ownership. An existing receipt can be read separately.
    fn admit_chat_write(
        &self,
        ctx: MaintenanceContext,
        scope: HistoryScope,
        thread: ChatThreadId,
        ownership_lost: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>>;

    fn register_owner(
        &self,
        ctx: MaintenanceContext,
        request: RunOwnershipRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn LiveRunOwner>>;

    /// Give positive evidence that no live owner can still act for `previous`
    /// on this thread and prevent replacement ownership until the returned
    /// fence drops. Return None when the prior owner is still live or uncertain.
    fn fence_orphan(
        &self,
        ctx: MaintenanceContext,
        scope: HistoryScope,
        thread: ChatThreadId,
        previous: AgentRunId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>>;
}

pub trait LiveRunOwner: Send + Sync {
    fn is_current(&self) -> bool;
    fn prior_owner_fenced(&self, run: &AgentRunId) -> bool;
}

enum Coordination {
    Local,
    Clustered(Arc<dyn ClusterRunAuthority>),
}

enum OwnerLease {
    Local,
    Clustered(Box<dyn LiveRunOwner>),
}

impl OwnerLease {
    fn check(&self) -> Result<(), PortError> {
        if matches!(self, Self::Clustered(owner) if !owner.is_current()) {
            return Err(owner_unavailable());
        }
        Ok(())
    }

    fn can_recover(&self, previous: &AgentRunId) -> bool {
        match self {
            Self::Local => true,
            Self::Clustered(owner) => owner.is_current() && owner.prior_owner_fenced(previous),
        }
    }
}

#[derive(Clone)]
pub struct AgentRunSupervisor {
    inner: Arc<SupervisorState>,
}

type ThreadKey = (SpaceId, ChatThreadId);
type ScopedThreadKey = (HistoryScope, ChatThreadId);

struct SupervisorState {
    registry: Arc<ToolRegistry>,
    revocations: Arc<RevocationHub>,
    coordination: Coordination,
    threads: Mutex<ThreadRuns>,
    shutdown: Cancellation,
}

#[derive(Default)]
struct ThreadRuns {
    gates: BTreeMap<ThreadKey, Weak<AsyncMutex<()>>>,
    admitting: BTreeMap<AgentRunId, Cancellation>,
    active: BTreeMap<ThreadKey, Arc<ActiveRun>>,
    streams: BTreeMap<ScopedThreadKey, Vec<Weak<StepStreamBuffer>>>,
}

/// Track the candidate while its predecessor remains active during admission.
struct RunAdmission<'a> {
    threads: &'a Mutex<ThreadRuns>,
    run: &'a AgentRunId,
}

impl Drop for RunAdmission<'_> {
    fn drop(&mut self) {
        let mut threads = self
            .threads
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        threads.admitting.remove(self.run);
    }
}

struct ActiveRun {
    id: AgentRunId,
    scope: HistoryScope,
    thread: ChatThreadId,
    auth: EngineAuthContext,
    owner_auth: EngineAuthContext,
    project: Option<FolderRef>,
    kind: ChatThreadKind,
    request: RequestId,
    options: ChatRunOptions,
    started: Instant,
    stream: Arc<StepStreamBuffer>,
    cancellation: Cancellation,
    lease: RunRevocationLease,
    owner: OwnerLease,
    admitted: AtomicBool,
}

enum LaunchOutcome {
    Started(AgentRunId),
    Draining(PortError),
    /// A conflicting or already settled claim ends this automatic handoff.
    Settled(PortError),
}

enum ClaimSettlement {
    Retired,
    Changed,
    Pending,
}

enum RunTaskStart {
    Admitted(ThreadEntrySeq),
    DrainOnly(PortError),
}

impl AgentRunSupervisor {
    pub fn new_local(
        registry: Arc<ToolRegistry>,
        revocations: Arc<RevocationHub>,
        _writer: ExclusiveDataRoot,
    ) -> Self {
        Self::new(registry, revocations, Coordination::Local)
    }

    pub fn new_clustered(
        registry: Arc<ToolRegistry>,
        local_revocations: Arc<RevocationHub>,
        authority: Arc<dyn ClusterRunAuthority>,
    ) -> Self {
        Self::new(
            registry,
            local_revocations,
            Coordination::Clustered(authority),
        )
    }

    fn new(
        registry: Arc<ToolRegistry>,
        revocations: Arc<RevocationHub>,
        coordination: Coordination,
    ) -> Self {
        Self {
            inner: Arc::new(SupervisorState {
                registry,
                revocations,
                coordination,
                threads: Mutex::new(ThreadRuns::default()),
                shutdown: Cancellation::default(),
            }),
        }
    }

    /// Explicit activation of an already visible branch. The worker owns its
    /// cancellation once admitted and does not borrow the caller's socket.
    pub async fn start(
        &self,
        account: AccountContext,
        request: StartChatRun,
    ) -> Result<AgentRunId, PortError> {
        let service = self.clone();
        detached(async move {
            let deadline = deadline_from(account.budget.remaining);
            let mut account = service.live_account(account).await?;
            if account.auth().kind() != &PrincipalKind::DirectHuman {
                return Err(DomainError::AccessDenied.into());
            }
            let _admission = service
                .lock_thread_gate(
                    &request.scope,
                    &request.thread,
                    &mut account.budget,
                    deadline,
                )
                .await?;
            let owner = service.independent_chat_human(&account).await?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(gate_deadline());
            }
            account.budget.remaining = remaining;
            let ctx = SpaceContext::new(
                account.auth().clone(),
                request.scope.clone(),
                account.budget.clone(),
            )?;
            let branch = service
                .thread_at(ctx, &request.thread, request.expected_leaf)
                .await?;
            match service
                .launch(
                    AccountContext::new(owner, account.budget),
                    request,
                    branch.thread,
                    None,
                    None,
                )
                .await?
            {
                LaunchOutcome::Started(run) => Ok(run),
                LaunchOutcome::Draining(error) | LaunchOutcome::Settled(error) => Err(error),
            }
        })
        .await
    }

    pub async fn enqueue_input(
        &self,
        account: AccountContext,
        request: SubmitUserChatInput,
        options: ChatRunOptions,
    ) -> Result<ChatSubmission, PortError> {
        let service = self.clone();
        detached(async move { service.submit(account, request, options).await }).await
    }

    pub async fn subscribe(
        &self,
        account: AccountContext,
        scope: HistoryScope,
        thread: ChatThreadId,
        cursor: Option<&StreamCursor>,
    ) -> Result<Option<ChatSubscription>, PortError> {
        let cancellation = Cancellation::default();
        let revocation = self.inner.revocations.register_viewer(
            maintenance(account.budget.clone()),
            account.auth(),
            &scope.space_id,
            cancellation.clone(),
        )?;
        let (auth, expires_at) = self
            .inner
            .registry
            .control()
            .revalidate_chat_viewer(account.clone())
            .await?;
        let ctx = SpaceContext::new(auth, scope.clone(), account.budget)?;
        let branch = self
            .thread_at(ctx.clone(), &thread, ThreadEntrySeq::ZERO)
            .await?;
        let active = self.active(&scope, &thread);
        if let Some(run) =
            active.filter(|run| run.scope == scope && run.admitted.load(Ordering::Acquire))
        {
            self.refresh_peer_head(&run, ctx, branch.thread.head)
                .await?;
            Ok(Some(ChatSubscription {
                stream: run.stream.subscribe(cursor),
                cancellation,
                expires_at: expires_at.map(Instant::from_std),
                _revocation: revocation,
                _buffer: run.stream.clone(),
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn stop(
        &self,
        account: AccountContext,
        scope: HistoryScope,
        thread: ChatThreadId,
        run: AgentRunId,
    ) -> Result<(), PortError> {
        require_write_bearer(account.auth())?;
        let ctx = SpaceContext::new(
            account.auth().clone(),
            scope.clone(),
            account.budget.clone(),
        )?;
        let ctx = self
            .inner
            .registry
            .control()
            .fence_canonical_effect(account.auth().clone(), ctx, CanonicalEffect::ChatStop)
            .await?;
        let branch = self
            .thread_at(ctx.clone(), &thread, ThreadEntrySeq::ZERO)
            .await?;
        let permit = ctx
            .canonical_effect()
            .ok_or_else(|| invalid(ValidationReason::InvalidAuthority))?
            .begin()
            .await?;
        let active = self
            .active(&scope, &thread)
            .filter(|active| {
                active.id == run && active.scope == scope && active.admitted.load(Ordering::Acquire)
            })
            .ok_or(DomainError::ResourceNotFound)?;
        if active.auth.principal() != ctx.auth().principal()
            && !ctx
                .auth()
                .spaces()
                .get(&branch.thread.space)
                .is_some_and(|grant| {
                    matches!(
                        grant.role,
                        notarium_core::auth::SpaceRole::Owner
                            | notarium_core::auth::SpaceRole::Editor
                    )
                })
        {
            return Err(DomainError::AccessDenied.into());
        }
        permit.check()?;
        active.cancellation.cancel();
        Ok(())
    }

    pub async fn rollback_run(
        &self,
        account: AccountContext,
        scope: HistoryScope,
        run: AgentRunId,
        key: CommandKey,
    ) -> Result<Committed<RollbackResult>, PortError> {
        let service = self.clone();
        detached(async move {
            let started = tokio::time::Instant::now();
            let remaining_budget = || {
                let mut budget = account.budget.clone();
                budget.remaining = budget.remaining.saturating_sub(started.elapsed());
                budget
            };
            account.auth().authorize_human_management()?;
            let live_auth = service
                .inner
                .registry
                .control()
                .revalidate_auth(AccountContext::new(
                    account.auth().clone(),
                    remaining_budget(),
                ))
                .await?;
            live_auth.authorize_human_management()?;
            let grant = live_auth
                .spaces()
                .get(&scope.space_id)
                .ok_or(DomainError::ResourceNotFound)?;
            if grant.role == notarium_core::auth::SpaceRole::Viewer {
                return Err(DomainError::AccessDenied.into());
            }
            let _drain = service
                .inner
                .revocations
                .stop_and_drain_run(&scope.space_id, &run, &remaining_budget())
                .await?;
            service
                .inner
                .registry
                .control()
                .ensure_run_inactive(
                    AccountContext::new(live_auth.clone(), remaining_budget()),
                    scope.space_id.clone(),
                    run.clone(),
                )
                .await?;
            let ctx = SpaceContext::new(live_auth.clone(), scope.clone(), remaining_budget())?;
            let ctx = service
                .inner
                .registry
                .control()
                .fence_canonical_effect(live_auth.clone(), ctx, CanonicalEffect::ChatRollback)
                .await?;
            service
                .inner
                .registry
                .engine()
                .rollback_agent_run_by_id(
                    ctx,
                    Mutation {
                        identity: CommandIdentity {
                            scope,
                            actor: live_auth.principal().clone(),
                            key,
                            hash: derive_digest(
                                "notarium.chats.rollback.v1",
                                &[run.as_str().as_bytes()],
                            ),
                        },
                        preconditions: Preconditions::default(),
                        input: run,
                    },
                )
                .await
        })
        .await
    }

    /// Redact an entry and stop the local owner of any turn using this branch.
    pub async fn redact_chat_entry(
        &self,
        mut account: AccountContext,
        request: Mutation<RedactChatEntry>,
    ) -> Result<Committed<RedactedChat>, PortError> {
        let service = self.clone();
        detached(async move {
            let scope = request.identity.scope.clone();
            let thread = request.input.thread.clone();
            let deadline = deadline_from(account.budget.remaining);
            let _admission = service
                .lock_thread_gate(&scope, &thread, &mut account.budget, deadline)
                .await?;
            let mut account = service.live_account(account).await?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(gate_deadline());
            }
            account.budget.remaining = remaining;
            require_write_bearer(account.auth())?;
            let ownership_lost = Cancellation::default();
            account.budget = bounded(&account.budget, MAINTENANCE_BUDGET, ownership_lost);
            let route = service
                .admit_chat_route(&scope, &thread, &account.budget)
                .await?;
            let ctx = SpaceContext::new(
                account.auth().clone(),
                scope.clone(),
                account.budget.clone(),
            )?;
            let ctx = service
                .inner
                .registry
                .control()
                .fence_canonical_effect(account.auth().clone(), ctx, CanonicalEffect::ChatRedaction)
                .await?;
            // A redaction changes the thread revision. Once this precondition
            // is stale, the writer can only replay a receipt or reject the
            // command. Runs admitted since that commit use the scrubbed history.
            let current = service
                .thread_at(ctx.clone(), &thread, ThreadEntrySeq::ZERO)
                .await?;
            let can_change = current.thread.revision == request.input.expected_thread_revision;
            let mut holds = Vec::new();
            if can_change
                && let Some(streams) = service
                    .inner
                    .threads
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .streams
                    .get(&(scope.clone(), thread.clone()))
            {
                holds.extend(
                    streams
                        .iter()
                        .filter_map(Weak::upgrade)
                        .map(|stream| stream.pause_for_redaction()),
                );
            }
            let result = match route.as_ref().map_or(Ok(()), |lease| lease.check()) {
                Ok(()) => {
                    service
                        .inner
                        .registry
                        .engine()
                        .redact_chat_entry(ctx, request)
                        .await
                }
                Err(error) => Err(error),
            };
            if can_change && (result.is_ok() || result.as_ref().is_err_and(queue::unknown_commit)) {
                if let Some(active) = service.active(&scope, &thread)
                    && active.scope == scope
                {
                    active.cancellation.cancel();
                }
            } else {
                for hold in &mut holds {
                    hold.keep_history();
                }
            }
            drop(holds);
            result
        })
        .await
    }

    pub fn shutdown(&self) {
        self.inner.shutdown.cancel();
        let state = self
            .inner
            .threads
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for cancellation in state.admitting.values() {
            cancellation.cancel();
        }
        for run in state.active.values() {
            run.cancellation.cancel();
        }
    }

    async fn live_account(&self, account: AccountContext) -> Result<AccountContext, PortError> {
        let auth = self
            .inner
            .registry
            .control()
            .revalidate_auth(account.clone())
            .await?;
        if !matches!(
            auth.kind(),
            PrincipalKind::DirectHuman | PrincipalKind::Pat | PrincipalKind::OAuth { .. }
        ) {
            return Err(DomainError::AccessDenied.into());
        }
        Ok(AccountContext::new(auth, account.budget))
    }

    // A detached turn may prepare a proposal on behalf of its interactive owner.
    // Keep that credential separate from reads that observe the branch's taint.
    async fn independent_chat_human(
        &self,
        account: &AccountContext,
    ) -> Result<EngineAuthContext, PortError> {
        if account.auth().authorize_proposal_confirmation().is_err() {
            return Ok(account.auth().clone());
        }
        self.inner
            .registry
            .control()
            .revalidate_proposal_human(account.clone(), ProposalHumanAccess::Write)
            .await
    }

    async fn detached_input_writer(
        &self,
        owner: &AccountContext,
        scope: &HistoryScope,
    ) -> Result<SpaceContext, PortError> {
        let writer = SpaceContext::new(
            self.independent_chat_human(owner).await?,
            scope.clone(),
            owner.budget.clone(),
        )?;
        self.inner
            .registry
            .control()
            .fence_canonical_effect(owner.auth().clone(), writer, CanonicalEffect::ChatInput)
            .await
    }

    async fn admit_chat_route(
        &self,
        scope: &HistoryScope,
        thread: &ChatThreadId,
        budget: &CallBudget,
    ) -> Result<Option<Box<dyn RevocationLease>>, PortError> {
        let Coordination::Clustered(authority) = &self.inner.coordination else {
            return Ok(None);
        };
        let lease = authority
            .admit_chat_write(
                maintenance(budget.clone()),
                scope.clone(),
                thread.clone(),
                budget.cancellation.clone(),
            )
            .await?;
        lease.check()?;
        Ok(Some(lease))
    }

    async fn thread_at(
        &self,
        ctx: SpaceContext,
        thread: &ChatThreadId,
        leaf: ThreadEntrySeq,
    ) -> Result<ChatBranch, PortError> {
        let branch = self
            .inner
            .registry
            .engine()
            .read_chat_context(
                ctx.clone(),
                ChatRead {
                    thread: thread.clone(),
                    leaf,
                    before: None,
                    max_entries: PageLimit::new(1)?,
                },
            )
            .await?;
        if branch.thread.space != ctx.scope().space_id || branch.thread.id != *thread {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        Ok(branch)
    }

    async fn refresh_peer_head(
        &self,
        run: &ActiveRun,
        ctx: SpaceContext,
        head: ThreadEntrySeq,
    ) -> Result<(), PortError> {
        if run.kind != ChatThreadKind::SpaceGroup || head == ThreadEntrySeq::ZERO {
            return Ok(());
        }
        let branch = self.thread_at(ctx, &run.thread, head).await?;
        if branch.thread.head == head
            && let Some(entry) = branch.entries.iter().find(|entry| {
                entry.seq == head
                    && matches!(entry.kind, ChatEntryKind::Human | ChatEntryKind::Redacted)
            })
        {
            run.stream.committed(entry, None)?;
        }
        Ok(())
    }

    async fn refresh_current_head(
        &self,
        run: &ActiveRun,
        include_own: bool,
    ) -> Result<(), PortError> {
        if run.kind != ChatThreadKind::SpaceGroup && !include_own {
            return Ok(());
        }
        run.owner.check()?;
        let account = self
            .live_account(AccountContext::new(
                run.owner_auth.clone(),
                cleanup_budget(&run.request),
            ))
            .await?;
        let ctx = SpaceContext::new(account.auth().clone(), run.scope.clone(), account.budget)?;
        let branch = self
            .thread_at(ctx.clone(), &run.thread, ThreadEntrySeq::ZERO)
            .await?;
        if branch.thread.head == ThreadEntrySeq::ZERO {
            return Ok(());
        }
        let head = branch.thread.head;
        let tail = self.thread_at(ctx, &run.thread, head).await?;
        if tail.thread.head == head
            && let Some(entry) = tail.entries.iter().find(|entry| {
                entry.seq == head
                    && ((run.kind == ChatThreadKind::SpaceGroup
                        && matches!(entry.kind, ChatEntryKind::Human | ChatEntryKind::Redacted))
                        || (include_own
                            && entry.run.as_ref() == Some(&run.id)
                            && matches!(
                                entry.kind,
                                ChatEntryKind::Model
                                    | ChatEntryKind::Tool { .. }
                                    | ChatEntryKind::Compaction
                                    | ChatEntryKind::Redacted
                            )))
            })
        {
            run.stream.reconcile_committed(entry)?;
        }
        Ok(())
    }

    fn thread_gate(&self, scope: &HistoryScope, thread: &ChatThreadId) -> Arc<AsyncMutex<()>> {
        let mut state = self
            .inner
            .threads
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.gates.retain(|_, gate| gate.strong_count() != 0);
        state.streams.retain(|_, streams| {
            streams.retain(|stream| stream.strong_count() != 0);
            !streams.is_empty()
        });
        let key = (scope.space_id.clone(), thread.clone());
        if let Some(gate) = state.gates.get(&key).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(AsyncMutex::new(()));
        state.gates.insert(key, Arc::downgrade(&gate));
        gate
    }

    async fn lock_thread_gate(
        &self,
        scope: &HistoryScope,
        thread: &ChatThreadId,
        budget: &mut CallBudget,
        deadline: Instant,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, PortError> {
        let gate = self.thread_gate(scope, thread);
        lock_gate(gate, &self.inner.shutdown, budget, deadline).await
    }

    fn active(&self, scope: &HistoryScope, thread: &ChatThreadId) -> Option<Arc<ActiveRun>> {
        self.inner
            .threads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .get(&(scope.space_id.clone(), thread.clone()))
            .cloned()
    }

    async fn launch(
        &self,
        account: AccountContext,
        request: StartChatRun,
        thread: ChatThread,
        predecessor: Option<&AgentRunId>,
        sender: Option<(&PendingCredentialKey, &PendingCredential)>,
    ) -> Result<LaunchOutcome, PortError> {
        if self.inner.shutdown.is_cancelled() {
            return Err(owner_unavailable());
        }
        if !request.options.limits.fits(RunLimits::HARD_CEILING) {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        if thread.head != request.expected_leaf
            || thread.id != request.thread
            || thread.space != request.scope.space_id
        {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        let audience = match thread.kind {
            ChatThreadKind::Personal => ChatAudience::Personal,
            ChatThreadKind::SpaceGroup => ChatAudience::Shared,
            ChatThreadKind::KeeperLog => return Err(DomainError::AccessDenied.into()),
        };
        if let Some(existing) = self.active(&request.scope, &request.thread)
            && Some(&existing.id) != predecessor
        {
            return Ok(LaunchOutcome::Settled(owner_unavailable()));
        }
        let run = new_run()?;
        let mut requested = account.auth().spaces().clone();
        for (space_id, grant) in &mut requested {
            grant
                .write_classes
                .retain(|class| matches!(class, DocClass::UserDoc | DocClass::AgentMemory));
            if space_id == &request.scope.space_id
                && let Some(project) = &thread.project_folder
            {
                if let Some(existing) = &grant.project_root
                    && existing != project
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                grant.project_root = Some(project.clone());
            }
        }
        let auth = account.auth().for_agent_run(
            run.clone(),
            request.scope.space_id.clone(),
            audience,
            requested,
        )?;
        let cancellation = Cancellation::default();
        let admission = bounded(&account.budget, MAINTENANCE_BUDGET, cancellation.clone());
        let lease = self.inner.revocations.register_run_with_sender(
            maintenance(admission.clone()),
            &auth,
            None,
            cancellation.clone(),
            Some((request.scope.clone(), request.thread.clone())),
            sender,
        )?;
        let registration = {
            let mut threads = self
                .inner
                .threads
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.inner.shutdown.is_cancelled() {
                return Ok(LaunchOutcome::Settled(owner_unavailable()));
            }
            threads.admitting.insert(run.clone(), cancellation.clone());
            RunAdmission {
                threads: &self.inner.threads,
                run: &run,
            }
        };
        let owner = match &self.inner.coordination {
            Coordination::Local => OwnerLease::Local,
            Coordination::Clustered(authority) => {
                let transition = match (predecessor, thread.active_run.as_ref()) {
                    (Some(previous), _) => RunOwnershipTransition::Handoff {
                        previous: previous.clone(),
                    },
                    (None, Some(previous)) => RunOwnershipTransition::Recover {
                        previous: previous.clone(),
                    },
                    (None, None) => RunOwnershipTransition::Vacant,
                };
                OwnerLease::Clustered(
                    authority
                        .register_owner(
                            maintenance(admission.clone()),
                            RunOwnershipRequest {
                                scope: request.scope.clone(),
                                thread: request.thread.clone(),
                                run: run.clone(),
                                transition,
                            },
                            cancellation.clone(),
                        )
                        .await?,
                )
            }
        };
        if self.inner.shutdown.is_cancelled() {
            return Ok(LaunchOutcome::Settled(owner_unavailable()));
        }
        lease.check()?;
        let account = self
            .live_account(AccountContext::new(
                account.auth().clone(),
                admission.clone(),
            ))
            .await?;
        let mut ctx = SpaceContext::new(auth, request.scope.clone(), account.budget.clone())?;
        let leaf = self
            .thread_at(ctx.clone(), &request.thread, request.expected_leaf)
            .await?;
        owner.check()?;
        lease.check()?;
        if let Some(previous) = leaf.thread.active_run.as_ref()
            && predecessor.is_none()
        {
            if thread.active_run.as_ref() != Some(previous) || !owner.can_recover(previous) {
                return Ok(LaunchOutcome::Settled(owner_unavailable()));
            }
            let recovered = self
                .recover_orphaned_run(&account, &request.scope, &request.thread, previous, || {
                    owner.check()?;
                    lease.check()
                })
                .await?;
            if recovered != FinishChatRunOutcome::Cleared {
                return Err(owner_unavailable());
            }
            owner.check()?;
            lease.check()?;
        }
        ctx = self
            .inner
            .registry
            .control()
            .fence_canonical_effect(account.auth().clone(), ctx, CanonicalEffect::ChatClaim)
            .await?;
        owner.check()?;
        lease.check()?;
        let key = (request.scope.space_id.clone(), request.thread.clone());
        let state = Arc::new(ActiveRun {
            id: run.clone(),
            scope: request.scope.clone(),
            thread: request.thread.clone(),
            project: thread.project_folder.map(|folder_id| FolderRef {
                space_id: request.scope.space_id.clone(),
                folder_id,
            }),
            kind: thread.kind,
            auth: ctx.auth().clone(),
            owner_auth: account.auth().clone(),
            request: admission.request.clone(),
            options: request.options,
            started: Instant::now(),
            stream: Arc::new(StepStreamBuffer::new(
                run.clone(),
                request.thread.clone(),
                request.expected_leaf,
            )),
            cancellation,
            lease,
            owner,
            admitted: AtomicBool::new(false),
        });
        let previous = {
            let mut threads = self
                .inner
                .threads
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            // Shutdown cancels every published candidate under this same lock.
            if self.inner.shutdown.is_cancelled() {
                return Ok(LaunchOutcome::Settled(owner_unavailable()));
            }
            threads
                .streams
                .entry((request.scope.clone(), request.thread.clone()))
                .or_default()
                .push(Arc::downgrade(&state.stream));
            threads.active.insert(key.clone(), state.clone())
        };
        drop(registration);
        let claim_request = ClaimChatRun {
            thread: request.thread,
            run: run.clone(),
            expected_leaf: request.expected_leaf,
            previous_run: predecessor.cloned(),
        };
        // The canonical executor owns the effect lease through commit. A
        // delayed response must not keep a subsequent logout waiting on it.
        let claim = self
            .inner
            .registry
            .engine()
            .claim_active_run(ctx, claim_request.clone())
            .await;
        let claim = match claim {
            Err(first) if queue::unknown_commit(&first) => {
                match self.retry_claim(&state, claim_request).await {
                    Err(retry) if !queue::unknown_commit(&retry) => Err(first),
                    settled => settled,
                }
            }
            known => known,
        };
        let error = match claim {
            Ok(ClaimChatRunOutcome::Claimed) => {
                if let Err(error) = state.owner.check().and_then(|_| state.lease.check()) {
                    error
                } else {
                    state.admitted.store(true, Ordering::Release);
                    self.spawn_run(state, RunTaskStart::Admitted(request.expected_leaf));
                    return Ok(LaunchOutcome::Started(run));
                }
            }
            Err(error) if queue::unknown_commit(&error) => error,
            Ok(ClaimChatRunOutcome::Busy(_) | ClaimChatRunOutcome::Changed) => {
                self.restore_predecessor(key, previous);
                return Ok(LaunchOutcome::Settled(owner_unavailable()));
            }
            Err(error) => {
                self.restore_predecessor(key, previous);
                return Err(error);
            }
        };

        state.cancellation.cancel();
        match self.settle_unpublished_claim(&state).await {
            ClaimSettlement::Pending => {
                self.spawn_run(state, RunTaskStart::DrainOnly(error.clone()));
                Ok(LaunchOutcome::Draining(error))
            }
            ClaimSettlement::Changed => {
                self.restore_predecessor(key, previous);
                Ok(LaunchOutcome::Settled(error))
            }
            ClaimSettlement::Retired => {
                self.remove_run(&state);
                Ok(LaunchOutcome::Settled(error))
            }
        }
    }

    async fn retry_claim(
        &self,
        run: &ActiveRun,
        request: ClaimChatRun,
    ) -> Result<ClaimChatRunOutcome, PortError> {
        let ctx = run.context(MAINTENANCE_BUDGET)?;
        let ctx = self
            .inner
            .registry
            .control()
            .fence_canonical_effect(run.owner_auth.clone(), ctx, CanonicalEffect::ChatClaim)
            .await?;
        run.owner.check()?;
        run.lease.check()?;
        self.inner
            .registry
            .engine()
            .claim_active_run(ctx, request)
            .await
    }

    /// The thread gate remains held until an uncertain candidate is either
    /// cleared or has proved its claim. The canonical writer decides whether
    /// an exact close can proceed even if the application route was lost.
    async fn settle_unpublished_claim(&self, run: &ActiveRun) -> ClaimSettlement {
        let engine = self.inner.registry.engine();
        let request = ChatRunRequest {
            thread: run.thread.clone(),
            expected_run: run.id.clone(),
        };
        let mut delay = Duration::from_millis(25);
        loop {
            let owner_live = run.owner.check().is_ok();
            let result = match run.settlement_context() {
                Ok(ctx) => engine.finish_run_if_queue_empty(ctx, request.clone()).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(FinishChatRunOutcome::Cleared) => {
                    self.inner
                        .revocations
                        .finish_thread_pending(&run.scope, &run.thread);
                    return ClaimSettlement::Retired;
                }
                Ok(FinishChatRunOutcome::Changed) => return ClaimSettlement::Changed,
                Ok(FinishChatRunOutcome::Pending)
                    if owner_live && !self.inner.shutdown.is_cancelled() =>
                {
                    return ClaimSettlement::Pending;
                }
                Ok(FinishChatRunOutcome::Pending) => return ClaimSettlement::Retired,
                Err(error) if !queue::retry_cleanup(&error) => {
                    return ClaimSettlement::Retired;
                }
                _ if !owner_live || self.inner.shutdown.is_cancelled() => {
                    return ClaimSettlement::Retired;
                }
                _ => (),
            }
            tokio::select! {
                () = tokio::time::sleep(delay) => (),
                () = self.inner.shutdown.cancelled() => return ClaimSettlement::Retired,
            }
            delay = (delay * 2).min(Duration::from_secs(2));
        }
    }

    pub(super) async fn recover_orphaned_run(
        &self,
        account: &AccountContext,
        scope: &HistoryScope,
        thread: &ChatThreadId,
        previous: &AgentRunId,
        mut check_live: impl FnMut() -> Result<(), PortError>,
    ) -> Result<FinishChatRunOutcome, PortError> {
        check_live()?;
        let engine = self.inner.registry.engine();
        let human = self.detached_input_writer(account, scope).await?;
        check_live()?;
        let recovery = ChatRunRequest {
            thread: thread.clone(),
            expected_run: previous.clone(),
        };
        let mut recovered = engine
            .recover_active_run(human.clone(), recovery.clone())
            .await;
        if recovered.as_ref().is_err_and(queue::unknown_commit) {
            check_live()?;
            if let Some(effect) = human.canonical_effect() {
                effect.check()?;
            }
            recovered = engine.recover_active_run(human, recovery).await;
        }
        if matches!(recovered, Ok(FinishChatRunOutcome::Cleared)) {
            self.inner.revocations.finish_thread_pending(scope, thread);
        }
        recovered
    }

    fn spawn_run(&self, run: Arc<ActiveRun>, start: RunTaskStart) {
        struct RunTaskGuard {
            worker: AgentRunSupervisor,
            run: Arc<ActiveRun>,
            completed: bool,
        }
        impl Drop for RunTaskGuard {
            fn drop(&mut self) {
                if !self.completed {
                    self.run.cancellation.cancel();
                    self.worker
                        .finish_and_remove_run(&self.run, Some(owner_unavailable()));
                }
            }
        }
        let worker = self.clone();
        tokio::spawn(async move {
            let mut guard = RunTaskGuard {
                worker: worker.clone(),
                run: Arc::clone(&run),
                completed: false,
            };
            worker.run_task(run, start).await;
            guard.completed = true;
        });
    }

    fn restore_predecessor(&self, key: ThreadKey, predecessor: Option<Arc<ActiveRun>>) {
        let mut threads = self
            .inner
            .threads
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(predecessor) = predecessor {
            if self.inner.shutdown.is_cancelled() {
                predecessor.cancellation.cancel();
            }
            threads.active.insert(key, predecessor);
        } else {
            threads.active.remove(&key);
        }
    }

    fn remove_run(&self, run: &ActiveRun) {
        let key = (run.scope.space_id.clone(), run.thread.clone());
        let mut state = self
            .inner
            .threads
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state
            .active
            .get(&key)
            .is_some_and(|active| active.id == run.id)
        {
            state.active.remove(&key);
        }
    }
}

impl ActiveRun {
    fn context(&self, remaining: Duration) -> Result<SpaceContext, PortError> {
        self.owner.check()?;
        self.lease.check()?;
        Ok(SpaceContext::new(
            self.auth.clone(),
            self.scope.clone(),
            CallBudget {
                request: self.request.clone(),
                cancellation: self.cancellation.clone(),
                remaining,
            },
        )?)
    }

    fn cleanup_context(&self) -> Result<SpaceContext, PortError> {
        self.owner.check()?;
        self.settlement_context()
    }

    fn settlement_context(&self) -> Result<SpaceContext, PortError> {
        Ok(SpaceContext::new(
            self.auth.clone(),
            self.scope.clone(),
            cleanup_budget(&self.request),
        )?)
    }

    fn command<T>(&self, label: &str, step: u32, input: T) -> Mutation<T> {
        let parts = [
            self.id.as_str().as_bytes(),
            label.as_bytes(),
            &step.to_be_bytes(),
        ];
        Mutation {
            identity: CommandIdentity {
                scope: self.scope.clone(),
                actor: self.auth.principal().clone(),
                key: derive_key("notarium.chats.command.v1", &parts),
                hash: derive_digest("notarium.chats.command-hash.v1", &parts),
            },
            preconditions: Preconditions::default(),
            input,
        }
    }
}

async fn detached<T: Send + 'static>(
    work: impl std::future::Future<Output = Result<T, PortError>> + Send + 'static,
) -> Result<T, PortError> {
    let (reply, receive) = oneshot::channel();
    tokio::spawn(async move {
        let _ = reply.send(work.await);
    });
    receive.await.map_err(|_| owner_unavailable())?
}

fn bounded(budget: &CallBudget, limit: Duration, cancellation: Cancellation) -> CallBudget {
    CallBudget {
        request: budget.request.clone(),
        remaining: budget.remaining.min(limit),
        cancellation,
    }
}

fn cleanup_budget(request: &RequestId) -> CallBudget {
    CallBudget {
        request: request.clone(),
        remaining: MAINTENANCE_BUDGET,
        cancellation: Cancellation::default(),
    }
}

fn maintenance(budget: CallBudget) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
        budget,
    }
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

fn deadline_from(remaining: Duration) -> Instant {
    let now = Instant::now();
    now.checked_add(remaining)
        .unwrap_or_else(|| now + Duration::from_secs(86_400))
}

async fn lock_gate(
    gate: Arc<AsyncMutex<()>>,
    shutdown: &Cancellation,
    budget: &mut CallBudget,
    deadline: Instant,
) -> Result<tokio::sync::OwnedMutexGuard<()>, PortError> {
    if shutdown.is_cancelled() {
        return Err(owner_unavailable());
    }
    if budget.cancellation.is_cancelled() {
        return Err(gate_cancelled());
    }
    if deadline <= Instant::now() {
        return Err(gate_deadline());
    }
    let guard = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Err(owner_unavailable()),
        () = budget.cancellation.cancelled() => return Err(gate_cancelled()),
        () = tokio::time::sleep_until(deadline) => return Err(gate_deadline()),
        guard = gate.lock_owned() => guard,
    };
    if shutdown.is_cancelled() {
        return Err(owner_unavailable());
    }
    if budget.cancellation.is_cancelled() {
        return Err(gate_cancelled());
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(gate_deadline());
    }
    budget.remaining = remaining;
    Ok(guard)
}

fn owner_unavailable() -> PortError {
    PortError::Unavailable(
        OperationalFailure::new(
            derive_digest("notarium.chats.owner-unavailable.v1", &[]),
            CommitEffect::NotCommitted,
            RetryAdvice::Never,
            false,
        )
        .expect("valid retryable owner failure"),
    )
}

fn gate_cancelled() -> PortError {
    PortError::Cancelled(
        OperationalFailure::new(
            derive_digest("notarium.chats.gate-cancelled.v1", &[]),
            CommitEffect::NotCommitted,
            RetryAdvice::Never,
            false,
        )
        .expect("valid gate cancellation failure"),
    )
}

fn gate_deadline() -> PortError {
    PortError::DeadlineExceeded(
        OperationalFailure::new(
            derive_digest("notarium.chats.gate-deadline.v1", &[]),
            CommitEffect::NotCommitted,
            RetryAdvice::Never,
            false,
        )
        .expect("valid gate deadline failure"),
    )
}

fn new_run() -> Result<AgentRunId, PortError> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| owner_unavailable())?;
    Ok(AgentRunId::from_bytes(bytes))
}

fn stream_failure(error: &PortError) -> RunFailure {
    match error {
        PortError::Cancelled(_) => RunFailure::Cancelled,
        PortError::DeadlineExceeded(_) => RunFailure::DeadlineExceeded,
        PortError::Domain(DomainError::AuthenticationFailed | DomainError::SpaceReadOnly) => {
            RunFailure::AuthorityRevoked
        }
        PortError::Domain(DomainError::AccessDenied | DomainError::ResourceNotFound) => {
            RunFailure::HistoryUnavailable
        }
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::ProviderContentFiltered =>
        {
            RunFailure::ContentFiltered
        }
        PortError::Domain(DomainError::Provider { .. }) => RunFailure::ProviderUnavailable,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if matches!(
                diagnostic.reason,
                ValidationReason::ProviderConsentRequired
                    | ValidationReason::ClassEgressForbidden
                    | ValidationReason::SourceMismatch
                    | ValidationReason::HistoryIncarnationMismatch
            ) =>
        {
            RunFailure::HistoryUnavailable
        }
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if matches!(
                diagnostic.reason,
                ValidationReason::BudgetExceeded | ValidationReason::TokenBudgetExceeded
            ) =>
        {
            RunFailure::BudgetExceeded
        }
        _ => RunFailure::Internal,
    }
}

fn require_write_bearer(auth: &EngineAuthContext) -> Result<(), PortError> {
    if matches!(
        auth.kind(),
        PrincipalKind::Pat | PrincipalKind::OAuth { .. }
    ) && auth.bearer_scope() != Some(BearerScope::Write)
    {
        return Err(DomainError::AccessDenied.into());
    }
    Ok(())
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    #[tokio::test]
    async fn thread_gate_wait_enforces_deadline_cancellation_and_subtracts_wait_time() {
        let gate = Arc::new(AsyncMutex::new(()));
        let shutdown = Cancellation::default();
        let held = gate.clone().lock_owned().await;

        // 1. Contended gate times out cleanly at deadline instead of waiting forever.
        let mut short_budget = CallBudget {
            request: RequestId::from_bytes([1; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_millis(40),
        };
        let started = Instant::now();
        let short_deadline = deadline_from(short_budget.remaining);
        let err = lock_gate(gate.clone(), &shutdown, &mut short_budget, short_deadline)
            .await
            .unwrap_err();
        assert!(matches!(err, PortError::DeadlineExceeded(_)), "{err:?}");
        assert!(started.elapsed() < Duration::from_millis(500));

        // 2. Contended gate respects caller cancellation immediately.
        let cancel = Cancellation::default();
        let mut cancel_budget = CallBudget {
            request: RequestId::from_bytes([2; 16]),
            cancellation: cancel.clone(),
            remaining: Duration::from_secs(5),
        };
        let cancel_trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            cancel_trigger.cancel();
        });
        let cancel_deadline = deadline_from(cancel_budget.remaining);
        let err = lock_gate(gate.clone(), &shutdown, &mut cancel_budget, cancel_deadline)
            .await
            .unwrap_err();
        assert!(matches!(err, PortError::Cancelled(_)), "{err:?}");

        // 3. When the gate releases before deadline, remaining budget is reduced by wait time.
        let mut wait_budget = CallBudget {
            request: RequestId::from_bytes([3; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_millis(500),
        };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            drop(held);
        });
        let wait_deadline = deadline_from(wait_budget.remaining);
        let _guard = lock_gate(gate, &shutdown, &mut wait_budget, wait_deadline)
            .await
            .unwrap();
        assert!(
            wait_budget.remaining <= Duration::from_millis(460),
            "remaining budget must subtract mutex wait time: {:?}",
            wait_budget.remaining
        );
    }
}
