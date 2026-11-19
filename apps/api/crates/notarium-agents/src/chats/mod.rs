//! Detached chat turns and their canonical branch ownership.

mod prompt;
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
    auth::{ChatAudience, EngineAuthContext, PrincipalKind},
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
    revocation::{RevocationHub, RunRevocationLease, ViewerRevocationLease},
};
use stream::{RunFailure, StepStreamBuffer, StepSubscription, StreamCursor, StreamRead};

const MAINTENANCE_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default)]
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
    _revocation: ViewerRevocationLease,
}

impl ChatSubscription {
    pub async fn next(&mut self) -> StreamRead {
        let next = tokio::select! {
            biased;
            () = self.cancellation.cancelled() => return StreamRead::Closed,
            next = self.stream.next() => next,
        };
        if self.cancellation.is_cancelled() {
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
/// predecessor. Loss of writer ownership cancels the supplied token.
pub trait ClusterRunAuthority: SessionRevocationPort {
    fn register_owner(
        &self,
        ctx: MaintenanceContext,
        request: RunOwnershipRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn LiveRunOwner>>;
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
    active: BTreeMap<ThreadKey, Arc<ActiveRun>>,
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
    stream: StepStreamBuffer,
    cancellation: Cancellation,
    lease: RunRevocationLease,
    owner: OwnerLease,
    admitted: AtomicBool,
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
            let account = service.live_account(account).await?;
            let gate = service.thread_gate(&request.scope, &request.thread);
            let _admission = gate.lock().await;
            let ctx = SpaceContext::new(
                account.auth().clone(),
                request.scope.clone(),
                account.budget.clone(),
            )?;
            let branch = service
                .thread_at(ctx, &request.thread, request.expected_leaf)
                .await?;
            service.launch(account, request, branch.thread, None).await
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
        let account = self.live_account(account).await?;
        let cancellation = Cancellation::default();
        let revocation = self.inner.revocations.register_viewer(
            maintenance(account.budget.clone()),
            account.auth(),
            &scope.space_id,
            cancellation.clone(),
        )?;
        let account = self.live_account(account).await?;
        let ctx = SpaceContext::new(
            account.auth().clone(),
            scope.clone(),
            account.budget.clone(),
        )?;
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
                _revocation: revocation,
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
        let account = self.live_account(account).await?;
        let ctx = SpaceContext::new(
            account.auth().clone(),
            scope.clone(),
            account.budget.clone(),
        )?;
        let branch = self.thread_at(ctx, &thread, ThreadEntrySeq::ZERO).await?;
        let active = self
            .active(&scope, &thread)
            .filter(|active| {
                active.id == run && active.scope == scope && active.admitted.load(Ordering::Acquire)
            })
            .ok_or(DomainError::ResourceNotFound)?;
        if active.auth.principal() != account.auth().principal()
            && &branch.thread.owner != account.auth().principal()
        {
            return Err(DomainError::AccessDenied.into());
        }
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
        let account = self.live_account(account).await?;
        account.auth().authorize_human_management()?;
        let ctx = SpaceContext::new(
            account.auth().clone(),
            scope.clone(),
            account.budget.clone(),
        )?;
        let input = self
            .inner
            .registry
            .engine()
            .prepare_agent_run_rollback(ctx.clone(), run.clone())
            .await?;
        self.inner
            .registry
            .engine()
            .rollback_agent_run(
                ctx,
                Mutation {
                    identity: CommandIdentity {
                        scope,
                        actor: account.auth().principal().clone(),
                        key,
                        hash: derive_digest(
                            "notarium.chats.rollback.v1",
                            &[run.as_str().as_bytes()],
                        ),
                    },
                    preconditions: Preconditions::default(),
                    input,
                },
            )
            .await
    }

    /// Redact an entry and stop the local owner of any turn using this branch.
    pub async fn redact_chat_entry(
        &self,
        account: AccountContext,
        request: Mutation<RedactChatEntry>,
    ) -> Result<Committed<RedactedChat>, PortError> {
        let account = self.live_account(account).await?;
        let scope = request.identity.scope.clone();
        let thread = request.input.thread.clone();
        let ctx = SpaceContext::new(account.auth().clone(), scope.clone(), account.budget)?;
        let redacted = self
            .inner
            .registry
            .engine()
            .redact_chat_entry(ctx, request)
            .await?;
        if let Some(active) = self.active(&scope, &thread) {
            active.cancellation.cancel();
        }
        Ok(redacted)
    }

    pub fn shutdown(&self) {
        self.inner.shutdown.cancel();
        let state = self.inner.threads.lock().expect("thread registry lock");
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
            && let Some(entry) = branch
                .entries
                .iter()
                .find(|entry| entry.seq == head && entry.kind == ChatEntryKind::Human)
        {
            run.stream.committed(entry, None)?;
        }
        Ok(())
    }

    fn thread_gate(&self, scope: &HistoryScope, thread: &ChatThreadId) -> Arc<AsyncMutex<()>> {
        let mut state = self.inner.threads.lock().expect("thread registry lock");
        state.gates.retain(|_, gate| gate.strong_count() != 0);
        let key = (scope.space_id.clone(), thread.clone());
        if let Some(gate) = state.gates.get(&key).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(AsyncMutex::new(()));
        state.gates.insert(key, Arc::downgrade(&gate));
        gate
    }

    fn active(&self, scope: &HistoryScope, thread: &ChatThreadId) -> Option<Arc<ActiveRun>> {
        self.inner
            .threads
            .lock()
            .expect("thread registry lock")
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
    ) -> Result<AgentRunId, PortError> {
        if self.inner.shutdown.is_cancelled()
            || !request.options.limits.fits(RunLimits::HARD_CEILING)
        {
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
            return Err(owner_unavailable());
        }
        let run = new_run()?;
        let mut requested = account.auth().spaces().clone();
        for grant in requested.values_mut() {
            grant
                .write_classes
                .retain(|class| matches!(class, DocClass::UserDoc | DocClass::AgentMemory));
        }
        let auth = account.auth().for_agent_run(
            run.clone(),
            request.scope.space_id.clone(),
            audience,
            requested,
        )?;
        let cancellation = Cancellation::default();
        let admission = bounded(&account.budget, MAINTENANCE_BUDGET, cancellation.clone());
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
        let lease = self.inner.revocations.register_run(
            maintenance(admission.clone()),
            &auth,
            None,
            cancellation.clone(),
        )?;
        let ctx = SpaceContext::new(auth.clone(), request.scope.clone(), admission.clone())?;
        let leaf = self
            .thread_at(ctx.clone(), &request.thread, request.expected_leaf)
            .await?;
        owner.check()?;
        lease.check()?;
        if let Some(previous) = leaf.thread.active_run.as_ref()
            && predecessor.is_none()
        {
            if !owner.can_recover(previous) {
                return Err(owner_unavailable());
            }
            let engine = self.inner.registry.engine();
            let human = SpaceContext::new(
                account.auth().clone(),
                request.scope.clone(),
                admission.clone(),
            )?;
            let recovery = ChatRunRequest {
                thread: request.thread.clone(),
                expected_run: previous.clone(),
            };
            let mut recovered = engine
                .recover_active_run(human.clone(), recovery.clone())
                .await;
            if recovered.as_ref().is_err_and(queue::unknown_commit) {
                owner.check()?;
                lease.check()?;
                recovered = engine.recover_active_run(human, recovery).await;
            }
            if recovered? != FinishChatRunOutcome::Cleared {
                return Err(owner_unavailable());
            }
            self.inner
                .revocations
                .finish_thread_pending(&request.scope, &request.thread);
            owner.check()?;
            lease.check()?;
        }
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
            auth,
            owner_auth: account.auth().clone(),
            request: admission.request.clone(),
            options: request.options,
            started: Instant::now(),
            stream: StepStreamBuffer::new(
                run.clone(),
                request.thread.clone(),
                request.expected_leaf,
            ),
            cancellation,
            lease,
            owner,
            admitted: AtomicBool::new(false),
        });
        let previous = self
            .inner
            .threads
            .lock()
            .expect("thread registry lock")
            .active
            .insert(key.clone(), state.clone());
        let claim_request = ClaimChatRun {
            thread: request.thread,
            run: run.clone(),
            expected_leaf: request.expected_leaf,
            previous_run: predecessor.cloned(),
        };
        let mut claim = self
            .inner
            .registry
            .engine()
            .claim_active_run(ctx, claim_request.clone())
            .await;
        if claim.as_ref().is_err_and(queue::unknown_commit)
            && let Ok(context) = state.cleanup_context()
        {
            claim = self
                .inner
                .registry
                .engine()
                .claim_active_run(context, claim_request)
                .await;
        }
        if !matches!(&claim, Ok(ClaimChatRunOutcome::Claimed)) {
            let mut threads = self.inner.threads.lock().expect("thread registry lock");
            if let Some(previous) = previous {
                threads.active.insert(key, previous);
            } else {
                threads.active.remove(&key);
            }
            return Err(claim.err().unwrap_or_else(owner_unavailable));
        }
        state.admitted.store(true, Ordering::Release);
        let worker = self.clone();
        tokio::spawn(async move {
            worker.run_task(state, request.expected_leaf).await;
        });
        Ok(run)
    }

    fn remove_run(&self, run: &ActiveRun) {
        let key = (run.scope.space_id.clone(), run.thread.clone());
        let mut state = self.inner.threads.lock().expect("thread registry lock");
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
