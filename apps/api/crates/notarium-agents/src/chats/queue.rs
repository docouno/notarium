use super::*;
use crate::revocation::{PendingCredential, PendingCredentialKey};
use notarium_core::auth::{SpaceLifecycle, SpaceRole};

pub(super) struct ConsumeAttempt {
    item: QueuedChatInput,
    key: PendingCredentialKey,
    command: Mutation<ConsumePending>,
}

impl AgentRunSupervisor {
    pub(super) async fn submit(
        &self,
        account: AccountContext,
        input: SubmitUserChatInput,
        options: ChatRunOptions,
    ) -> Result<ChatSubmission, PortError> {
        if self.inner.shutdown.is_cancelled() {
            return Err(owner_unavailable());
        }
        let mut account = self.live_account(account).await?;
        let scope = input.identity.scope.clone();
        let thread = input.thread.clone();
        let gate = self.thread_gate(&scope, &thread);
        let _admission = gate.lock().await;
        account = self.live_account(account).await?;
        let ownership_lost = Cancellation::default();
        account.budget = bounded(&account.budget, MAINTENANCE_BUDGET, ownership_lost.clone());
        let mut route = self
            .admit_chat_route(&scope, &thread, &account.budget)
            .await?;
        let ctx = SpaceContext::new(
            account.auth().clone(),
            scope.clone(),
            account.budget.clone(),
        )?;
        let engine = self.inner.registry.engine();
        let key = PendingCredentialKey {
            scope: scope.clone(),
            thread: thread.clone(),
            input: input.id.clone(),
        };
        let lookup = self
            .inner
            .registry
            .control()
            .fence_canonical_effect(
                account.auth().clone(),
                ctx.clone(),
                CanonicalEffect::ChatInput,
            )
            .await?;
        if let Some(outcome) = engine.lookup_user_chat_input(lookup, &input).await? {
            if matches!(outcome, SubmitUserChatOutcome::Appended(_)) {
                self.inner
                    .revocations
                    .finish_pending_submission(&key, &input.identity);
            }
            return Ok(ChatSubmission { outcome, run: None });
        }
        let latest = self
            .thread_at(ctx.clone(), &thread, ThreadEntrySeq::ZERO)
            .await?;
        if latest.thread.kind == ChatThreadKind::KeeperLog {
            return Err(DomainError::SpaceReadOnly.into());
        }
        let pending = self.inner.revocations.register_pending(
            maintenance(account.budget.clone()),
            key,
            account.auth().clone(),
            &input.identity,
            options.clone(),
        )?;
        let mentions_agent = input.mentions_agent;
        let mut submitted = self
            .publish_input(ctx.clone(), input.clone(), &mut route)
            .await;
        if let Err(first) = &submitted
            && unknown_commit(first)
            && !ownership_lost.is_cancelled()
            && route.as_ref().is_none_or(|lease| lease.check().is_ok())
        {
            match self.publish_input(ctx.clone(), input, &mut route).await {
                Ok(outcome) => submitted = Ok(outcome),
                Err(retry) if unknown_commit(&retry) => submitted = Err(retry),
                Err(_) => (),
            }
        }
        drop(route);
        let outcome = match submitted {
            Ok(outcome) => outcome,
            Err(error) => {
                if !unknown_commit(&error) {
                    self.inner.revocations.rollback_pending(pending);
                }
                return Err(error);
            }
        };
        if matches!(outcome, SubmitUserChatOutcome::Queued(_)) {
            return Ok(ChatSubmission { outcome, run: None });
        }
        self.inner.revocations.finish_registered_pending(pending);
        let mut run = None;
        if let SubmitUserChatOutcome::Appended(entry) = &outcome {
            if let Some(active) = self.active(&scope, &thread) {
                active.stream.committed(&entry.value, None)?;
            }
            if latest.thread.kind == ChatThreadKind::Personal || mentions_agent {
                let start = StartChatRun {
                    scope,
                    thread: thread.clone(),
                    expected_leaf: entry.value.seq,
                    options,
                };
                if let Ok(branch) = self.thread_at(ctx, &thread, entry.value.seq).await
                    && let Ok(LaunchOutcome::Started(id)) =
                        self.launch(account, start, branch.thread, None).await
                {
                    run = Some(id);
                }
            }
        }
        Ok(ChatSubmission { outcome, run })
    }

    async fn publish_input(
        &self,
        ctx: SpaceContext,
        input: SubmitUserChatInput,
        route: &mut Option<Box<dyn RevocationLease>>,
    ) -> Result<SubmitUserChatOutcome, PortError> {
        let writer = self
            .inner
            .registry
            .control()
            .fence_canonical_effect(ctx.auth().clone(), ctx, CanonicalEffect::ChatInput)
            .await?;
        if let Some(lease) = route {
            lease.check()?;
        }
        self.inner
            .registry
            .engine()
            .submit_user_chat_input(writer, input)
            .await
    }

    pub(super) async fn drain_locked(
        &self,
        run: &ActiveRun,
        unsettled: &mut Option<ConsumeAttempt>,
    ) -> Result<(), PortError> {
        let engine = self.inner.registry.engine();
        for _ in 0..32 {
            if unsettled.is_none() {
                match engine
                    .finish_run_if_queue_empty(
                        run.cleanup_context()?,
                        ChatRunRequest {
                            thread: run.thread.clone(),
                            expected_run: run.id.clone(),
                        },
                    )
                    .await?
                {
                    FinishChatRunOutcome::Cleared => {
                        self.inner
                            .revocations
                            .finish_thread_pending(&run.scope, &run.thread);
                        return Ok(());
                    }
                    FinishChatRunOutcome::Changed => return Ok(()),
                    FinishChatRunOutcome::Pending => (),
                }
                let queue = engine
                    .list_pending_chat_inputs(run.cleanup_context()?, run.thread.clone())
                    .await?;
                let Some(item) = queue.into_iter().next() else {
                    continue;
                };
                let current = self
                    .thread_at(run.cleanup_context()?, &run.thread, ThreadEntrySeq::ZERO)
                    .await?;
                if current.thread.active_run.as_ref() != Some(&run.id) {
                    return Ok(());
                }
                let parts = [run.id.as_str().as_bytes(), item.id.as_str().as_bytes()];
                let command = Mutation {
                    identity: CommandIdentity {
                        scope: run.scope.clone(),
                        actor: item.sender.clone(),
                        key: derive_key("notarium.chats.consume-key.v1", &parts),
                        hash: derive_digest("notarium.chats.consume-hash.v1", &parts),
                    },
                    preconditions: Preconditions::default(),
                    input: ConsumePending {
                        thread: run.thread.clone(),
                        input: item.id.clone(),
                        current_leaf: current.thread.head,
                        expected_run: item.in_flight_run.clone(),
                        expected_active_run: run.id.clone(),
                    },
                };
                let key = PendingCredentialKey {
                    scope: run.scope.clone(),
                    thread: run.thread.clone(),
                    input: item.id.clone(),
                };
                *unsettled = Some(ConsumeAttempt { item, key, command });
            }

            // An admitted consume can commit before the caller receives its reply.
            // Resolve that same command before consulting the now-shorter FIFO.
            let attempt = unsettled.as_ref().expect("an input was selected");
            let pending = self.inner.revocations.pending(&attempt.key);
            let account =
                if let Some(credential) = pending.filter(|_| !self.inner.shutdown.is_cancelled()) {
                    self.live_pending(run, &attempt.item, credential).await?
                } else {
                    None
                };
            let Some((account, options)) = account else {
                self.dismiss(run, &attempt.key).await?;
                *unsettled = None;
                continue;
            };
            let writer = SpaceContext::new(
                account.auth().clone(),
                run.scope.clone(),
                account.budget.clone(),
            )?;
            let writer = match self
                .inner
                .registry
                .control()
                .fence_canonical_effect(account.auth().clone(), writer, CanonicalEffect::ChatInput)
                .await
            {
                Ok(writer) => writer,
                Err(error) if no_authority(&error) => {
                    self.dismiss(run, &attempt.key).await?;
                    *unsettled = None;
                    continue;
                }
                Err(error) => return Err(error),
            };
            run.owner.check()?;
            let status = match engine
                .consume_chat_input(writer, attempt.command.clone())
                .await
            {
                Ok(content) => content.value,
                Err(error) if unknown_commit(&error) => return Err(error),
                Err(PortError::Domain(DomainError::RevisionConflict { .. })) => {
                    *unsettled = None;
                    continue;
                }
                Err(PortError::Cancelled(_)) => {
                    self.dismiss(run, &attempt.key).await?;
                    *unsettled = None;
                    continue;
                }
                Err(error) if queue_row_changed(&error) => {
                    let remaining = engine
                        .list_pending_chat_inputs(run.cleanup_context()?, run.thread.clone())
                        .await?;
                    if remaining
                        .first()
                        .is_some_and(|item| item.id == attempt.item.id)
                    {
                        return Err(error);
                    }
                    if remaining.iter().all(|item| item.id != attempt.item.id) {
                        self.inner.revocations.finish_pending(&attempt.key);
                    }
                    *unsettled = None;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match status {
                ConsumedPending::BranchChanged { .. } => {
                    self.dismiss(run, &attempt.key).await?;
                }
                ConsumedPending::AlreadyConsumed => {
                    self.inner.revocations.finish_pending(&attempt.key);
                }
                ConsumedPending::Appended {
                    entry,
                    intervening_human,
                } => {
                    let mentions_agent = attempt.item.mentions_agent;
                    run.stream.committed(&entry, None)?;
                    if !intervening_human
                        && (run.kind == ChatThreadKind::Personal || mentions_agent)
                    {
                        let next = StartChatRun {
                            scope: run.scope.clone(),
                            thread: run.thread.clone(),
                            expected_leaf: entry.seq,
                            options,
                        };
                        let follow = AccountContext::new(
                            account.auth().clone(),
                            cleanup_budget(&run.request),
                        );
                        let next_context = SpaceContext::new(
                            follow.auth().clone(),
                            run.scope.clone(),
                            follow.budget.clone(),
                        )?;
                        match self.thread_at(next_context, &run.thread, entry.seq).await {
                            Ok(branch) => {
                                if self
                                    .launch(follow, next, branch.thread, Some(&run.id))
                                    .await
                                    .is_ok()
                                {
                                    self.inner.revocations.finish_pending(&attempt.key);
                                    *unsettled = None;
                                    return Ok(());
                                }
                            }
                            Err(error) if no_authority(&error) => (),
                            Err(error) => return Err(error),
                        }
                    }
                    self.inner.revocations.finish_pending(&attempt.key);
                }
            }
            *unsettled = None;
        }
        // Release the gate and try again under a fresh cleanup budget.
        Err(owner_unavailable())
    }

    async fn dismiss(&self, run: &ActiveRun, key: &PendingCredentialKey) -> Result<(), PortError> {
        self.inner
            .registry
            .engine()
            .dismiss_chat_input(
                run.cleanup_context()?,
                DismissPending {
                    thread: run.thread.clone(),
                    input: key.input.clone(),
                },
            )
            .await?;
        self.inner.revocations.finish_pending(key);
        Ok(())
    }

    async fn live_pending(
        &self,
        run: &ActiveRun,
        item: &QueuedChatInput,
        credential: PendingCredential,
    ) -> Result<Option<(AccountContext, ChatRunOptions)>, PortError> {
        if credential.auth().principal() != &item.sender || credential.cancellation().is_cancelled()
        {
            return Ok(None);
        }
        let account = AccountContext::new(
            credential.auth().clone(),
            CallBudget {
                cancellation: credential.cancellation().clone(),
                ..cleanup_budget(&run.request)
            },
        );
        let account = match self.live_account(account).await {
            Ok(account) => account,
            Err(error) if no_authority(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut after = None;
        for _ in 0..128 {
            let page = self
                .inner
                .registry
                .control()
                .list_spaces(
                    account.clone(),
                    ControlPageRequest::new(100, after.clone())?,
                )
                .await;
            let page = match page {
                Ok(page) => page,
                Err(error) if no_authority(&error) => return Ok(None),
                Err(error) => return Err(error),
            };
            if let Some(access) = page
                .items
                .into_iter()
                .find(|space| space.space.id == run.scope.space_id)
            {
                return Ok((access.history == run.scope
                    && access.space.lifecycle == SpaceLifecycle::Active
                    && matches!(access.role, SpaceRole::Owner | SpaceRole::Editor)
                    && !credential.cancellation().is_cancelled())
                .then(|| (account, credential.options().clone())));
            }
            let Some(next) = page.continuation else {
                return Ok(None);
            };
            if after.as_ref() == Some(&next) {
                return Err(invalid(ValidationReason::InvalidState));
            }
            after = Some(next);
        }
        Err(invalid(ValidationReason::BudgetExceeded))
    }
}

fn queue_row_changed(error: &PortError) -> bool {
    matches!(error, PortError::Domain(DomainError::ResourceNotFound))
        || matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::InvalidState)
}

fn no_authority(error: &PortError) -> bool {
    matches!(
        error,
        PortError::Cancelled(_)
            | PortError::Domain(
                DomainError::AuthenticationFailed
                    | DomainError::AccessDenied
                    | DomainError::ResourceNotFound
                    | DomainError::SpaceReadOnly
            )
    )
}

pub(super) fn unknown_commit(error: &PortError) -> bool {
    matches!(error,
        PortError::Cancelled(failure) | PortError::DeadlineExceeded(failure)
        | PortError::Unavailable(failure) | PortError::Internal(failure)
        if failure.effect() == CommitEffect::Unknown)
}

pub(super) fn retry_cleanup(error: &PortError) -> bool {
    unknown_commit(error)
        || matches!(
            error,
            PortError::Unavailable(_) | PortError::DeadlineExceeded(_)
        )
}
