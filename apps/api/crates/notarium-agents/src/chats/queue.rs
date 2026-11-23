use super::*;
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
        if account.auth().kind() != &PrincipalKind::DirectHuman {
            return Err(DomainError::AccessDenied.into());
        }
        let scope = input.identity.scope.clone();
        let thread = input.thread.clone();
        let gate = self.thread_gate(&scope, &thread);
        let _admission = gate.lock().await;
        if self.inner.shutdown.is_cancelled() {
            return Err(owner_unavailable());
        }
        account = self.live_account(account).await?;
        if account.auth().kind() != &PrincipalKind::DirectHuman {
            return Err(DomainError::AccessDenied.into());
        }
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
        let identity = input.identity.clone();
        let mentions_agent = input.mentions_agent;
        let (outcome, may_start) =
            if let Some(outcome) = engine.lookup_user_chat_input(lookup, &input).await? {
                (outcome, true)
            } else {
                let owner = self.independent_chat_human(&account).await?;
                let latest = self
                    .thread_at(ctx.clone(), &thread, ThreadEntrySeq::ZERO)
                    .await?;
                if latest.thread.kind == ChatThreadKind::KeeperLog {
                    return Err(DomainError::SpaceReadOnly.into());
                }
                if let Some(orphaned) = latest.thread.active_run.as_ref()
                    && self.active(&scope, &thread).is_none()
                {
                    let (can_recover, mut recovery_fence) = match &self.inner.coordination {
                        Coordination::Local => (true, None),
                        Coordination::Clustered(authority) => match authority
                            .fence_orphan(
                                maintenance(account.budget.clone()),
                                scope.clone(),
                                thread.clone(),
                                orphaned.clone(),
                            )
                            .await
                        {
                            Ok(Some(fence)) if fence.check().is_ok() => (true, Some(fence)),
                            Ok(_) | Err(_) => (false, None),
                        },
                    };
                    if can_recover {
                        let recovered = self
                            .recover_orphaned_run(&account, &scope, &thread, orphaned, || {
                                if ownership_lost.is_cancelled() {
                                    return Err(owner_unavailable());
                                }
                                if let Some(lease) = route.as_mut() {
                                    lease.check()?;
                                }
                                if let Some(fence) = recovery_fence.as_mut() {
                                    fence.check()?;
                                }
                                Ok(())
                            })
                            .await;
                        match recovered {
                            Ok(
                                FinishChatRunOutcome::Cleared
                                | FinishChatRunOutcome::Changed
                                | FinishChatRunOutcome::Pending,
                            ) => {}
                            Err(PortError::Domain(DomainError::ValidationFailed {
                                diagnostic,
                            })) if diagnostic.reason == ValidationReason::InvalidAuthority => {
                                // The claim still belongs to this live writer generation or epoch;
                                // fall through to queue input onto the active run.
                            }
                            Err(error) => return Err(error),
                        }
                    }
                }
                let pending = self.inner.revocations.register_pending(
                    maintenance(account.budget.clone()),
                    key.clone(),
                    owner,
                    &input.identity,
                    options,
                )?;
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
                let outcome = match submitted {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        if !unknown_commit(&error) {
                            self.inner.revocations.rollback_pending(pending);
                        }
                        return Err(error);
                    }
                };
                if matches!(
                    outcome,
                    SubmitUserChatOutcome::Full { .. } | SubmitUserChatOutcome::Changed
                ) {
                    self.inner.revocations.finish_registered_pending(pending);
                }
                (
                    outcome,
                    latest.thread.kind == ChatThreadKind::Personal || mentions_agent,
                )
            };
        let mut run = None;
        if let SubmitUserChatOutcome::Appended(entry) = &outcome
            && let Some(sender) =
                self.inner
                    .revocations
                    .pending_submission(&key, &identity, account.auth())
        {
            if let Some(lease) = &route
                && let Err(error) = lease.check().map_err(after_append)
            {
                if !unknown_commit(&error) && concurrency_retry_delay(&error).is_none() {
                    self.inner.revocations.finish_submission(&key, &sender);
                }
                return Err(error);
            }
            drop(route);
            // A peer can resolve the same receipt through the shared hub. Keep
            // its sender revocable until the claim has a definitive outcome.
            let _handoff = sender.handoff.lock().await;
            let sender_live = || {
                self.inner
                    .revocations
                    .submission_live(&key, &sender)
                    .map_err(after_append)
            };
            if sender_live()? {
                let handoff_result: Result<(), PortError> = async {
                    let active = self.active(&scope, &thread);
                    let branch = if active.is_none() && may_start {
                        Some(
                            self.thread_at(ctx, &thread, entry.value.seq)
                                .await
                                .map_err(after_append)?,
                        )
                    } else {
                        None
                    };
                    if let Some(active) = active {
                        active.stream.committed(&entry.value, None)?;
                    } else if let Some(branch) = branch
                        && branch.thread.active_run.is_none()
                        && branch.thread.head == entry.value.seq
                        && (branch.thread.kind == ChatThreadKind::Personal || mentions_agent)
                        && branch.entries.iter().any(|current| {
                            current.seq == entry.value.seq && current.kind == ChatEntryKind::Human
                        })
                        && sender_live()?
                    {
                        let start = StartChatRun {
                            scope,
                            thread,
                            expected_leaf: entry.value.seq,
                            options: sender.options().clone(),
                        };
                        let owner = AccountContext::new(sender.auth().clone(), account.budget);
                        match self
                            .launch(owner, start, branch.thread, None, Some((&key, &sender)))
                            .await
                        {
                            Ok(LaunchOutcome::Started(id)) => run = Some(id),
                            Err(error)
                                if !self.inner.shutdown.is_cancelled()
                                    && !sender.cancellation().is_cancelled()
                                    && let Some(retry) = retry_handoff(&error) =>
                            {
                                return Err(retry);
                            }
                            _ => (),
                        }
                    }
                    Ok(())
                }
                .await;
                match handoff_result {
                    Ok(()) => {
                        self.inner.revocations.finish_submission(&key, &sender);
                    }
                    Err(error) => {
                        // Only retain the pending sender when the caller can
                        // retry the same command to claim the run.
                        if !unknown_commit(&error) && concurrency_retry_delay(&error).is_none() {
                            self.inner.revocations.finish_submission(&key, &sender);
                        }
                        return Err(error);
                    }
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
            let account = if let Some(credential) =
                pending.filter(|_| !self.inner.shutdown.is_cancelled())
            {
                match self.live_pending(run, &attempt.item, credential).await {
                    Ok(account) => account,
                    Err(error)
                        if !retry_cleanup(&error) && concurrency_retry_delay(&error).is_none() =>
                    {
                        None
                    }
                    Err(error) => return Err(error),
                }
            } else {
                None
            };
            let Some((account, sender)) = account else {
                self.dismiss(run, &attempt.key).await?;
                *unsettled = None;
                continue;
            };
            let writer = match self.detached_input_writer(&account, &run.scope).await {
                Ok(writer) => writer,
                Err(error)
                    if no_authority(&error)
                        || (!retry_cleanup(&error)
                            && concurrency_retry_delay(&error).is_none()) =>
                {
                    self.dismiss(run, &attempt.key).await?;
                    *unsettled = None;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let reader = writer.auth().clone();
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
                        self.dismiss(run, &attempt.key).await?;
                        *unsettled = None;
                        continue;
                    }
                    if remaining.iter().all(|item| item.id != attempt.item.id) {
                        self.inner.revocations.finish_pending(&attempt.key);
                    }
                    *unsettled = None;
                    continue;
                }
                Err(error)
                    if !retry_cleanup(&error) && concurrency_retry_delay(&error).is_none() =>
                {
                    // Dismiss a definitely rejected head-of-line item so it
                    // cannot livelock the thread's FIFO queue.
                    self.dismiss(run, &attempt.key).await?;
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
                            options: sender.options().clone(),
                        };
                        let follow = AccountContext::new(
                            account.auth().clone(),
                            cleanup_budget(&run.request),
                        );
                        let next_context =
                            SpaceContext::new(reader, run.scope.clone(), follow.budget.clone())?;
                        match self.thread_at(next_context, &run.thread, entry.seq).await {
                            Ok(branch) => {
                                match self
                                    .launch(
                                        follow,
                                        next,
                                        branch.thread,
                                        Some(&run.id),
                                        Some((&attempt.key, &sender)),
                                    )
                                    .await
                                {
                                    Ok(LaunchOutcome::Started(_) | LaunchOutcome::Draining(_)) => {
                                        self.inner.revocations.finish_pending(&attempt.key);
                                        *unsettled = None;
                                        return Ok(());
                                    }
                                    Err(error)
                                        if !self.inner.shutdown.is_cancelled()
                                            && retry_handoff(&error).is_some() =>
                                    {
                                        return Err(error);
                                    }
                                    _ => (),
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
    ) -> Result<Option<(AccountContext, PendingCredential)>, PortError> {
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
        let Some(grant) = account.auth().spaces().get(&run.scope.space_id) else {
            return Ok(None);
        };
        if !matches!(grant.role, SpaceRole::Owner | SpaceRole::Editor) {
            return Ok(None);
        }
        let space = match self
            .inner
            .registry
            .catalog()
            .space(account.budget.clone(), run.scope.space_id.clone())
            .await
        {
            Ok(space) => space,
            Err(error) if no_authority(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok((space.history == run.scope
            && space.space.lifecycle == SpaceLifecycle::Active
            && !credential.cancellation().is_cancelled())
        .then_some((account, credential)))
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

fn retry_handoff(error: &PortError) -> Option<PortError> {
    if concurrency_retry_delay(error).is_some() {
        return Some(error.clone());
    }
    let (PortError::Unavailable(failure) | PortError::DeadlineExceeded(failure)) = error else {
        return None;
    };
    if failure.effect() != CommitEffect::NotCommitted {
        return None;
    }
    // The input is already durable. The public retry resolves its same receipt
    // and may retry only the unclaimed run with the retained sender.
    Some(PortError::Unavailable(
        OperationalFailure::new(
            failure.diagnostic_ref(),
            CommitEffect::Unknown,
            RetryAdvice::RetrySameCommand,
            true,
        )
        .expect("the input has a durable receipt"),
    ))
}

fn after_append(error: PortError) -> PortError {
    retry_handoff(&error).unwrap_or(error)
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
            PortError::Unavailable(_) | PortError::DeadlineExceeded(_) | PortError::Internal(_)
        )
}

pub(super) fn concurrency_retry_delay(error: &PortError) -> Option<Duration> {
    match error {
        PortError::Domain(DomainError::RateLimited {
            budget: notarium_core::error::BudgetKind::Concurrency,
            retry_after_ms,
        }) => Some(Duration::from_millis(*retry_after_ms)),
        _ => None,
    }
}
