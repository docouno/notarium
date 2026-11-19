use super::*;
use crate::revocation::{PendingCredential, PendingCredentialKey};
use notarium_core::auth::{SpaceLifecycle, SpaceRole};

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
        let ownership_lost = Cancellation::default();
        account.budget = bounded(&account.budget, MAINTENANCE_BUDGET, ownership_lost.clone());
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
        if let Some(outcome) = engine.lookup_user_chat_input(ctx.clone(), &input).await? {
            if matches!(outcome, SubmitUserChatOutcome::Appended(_)) {
                self.inner.revocations.finish_pending(&key);
            }
            return Ok(ChatSubmission { outcome, run: None });
        }
        let latest = self
            .thread_at(ctx.clone(), &thread, ThreadEntrySeq::ZERO)
            .await?;
        if latest.thread.kind == ChatThreadKind::KeeperLog {
            return Err(DomainError::SpaceReadOnly.into());
        }
        let route = match &self.inner.coordination {
            Coordination::Local => None,
            Coordination::Clustered(authority) => {
                let route = authority
                    .admit_input(
                        maintenance(account.budget.clone()),
                        scope.clone(),
                        thread.clone(),
                        ownership_lost.clone(),
                    )
                    .await?;
                route.check()?;
                Some(route)
            }
        };
        let pending = self.inner.revocations.register_pending(
            maintenance(account.budget.clone()),
            key,
            account.auth().clone(),
            input.identity.hash,
            options.clone(),
        )?;
        let mentions_agent = input.mentions_agent;
        let mut submitted = engine
            .submit_user_chat_input(ctx.clone(), input.clone())
            .await;
        if submitted.as_ref().is_err_and(unknown_commit)
            && !ownership_lost.is_cancelled()
            && route.as_ref().is_none_or(|lease| lease.check().is_ok())
        {
            submitted = engine.submit_user_chat_input(ctx.clone(), input).await;
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
        self.inner.revocations.rollback_pending(pending);
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
                if let Ok(branch) = self.thread_at(ctx, &thread, entry.value.seq).await {
                    run = self.launch(account, start, branch.thread, None).await.ok();
                }
            }
        }
        Ok(ChatSubmission { outcome, run })
    }

    pub(super) async fn drain(&self, run: &ActiveRun) -> Result<(), PortError> {
        let gate = self.thread_gate(&run.scope, &run.thread);
        let _admission = gate.lock().await;
        let engine = self.inner.registry.engine();
        let active = || ChatRunRequest {
            thread: run.thread.clone(),
            expected_run: run.id.clone(),
        };
        for _ in 0..32 {
            match engine
                .finish_run_if_queue_empty(run.cleanup_context()?, active())
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
            let key = PendingCredentialKey {
                scope: run.scope.clone(),
                thread: run.thread.clone(),
                input: item.id.clone(),
            };
            let pending = self.inner.revocations.pending(&key);
            let account =
                if let Some(credential) = pending.filter(|_| !self.inner.shutdown.is_cancelled()) {
                    self.live_pending(run, &item, credential).await?
                } else {
                    None
                };
            let Some((account, options)) = account else {
                self.dismiss(run, &key).await?;
                continue;
            };
            let writer = SpaceContext::new(
                account.auth().clone(),
                run.scope.clone(),
                account.budget.clone(),
            )?;
            let current = self
                .thread_at(run.cleanup_context()?, &run.thread, ThreadEntrySeq::ZERO)
                .await?;
            if current.thread.active_run.as_ref() != Some(&run.id) {
                return Ok(());
            }
            run.owner.check()?;
            let parts = [run.id.as_str().as_bytes(), item.id.as_str().as_bytes()];
            let content = engine
                .consume_chat_input(
                    writer,
                    Mutation {
                        identity: CommandIdentity {
                            scope: run.scope.clone(),
                            actor: account.auth().principal().clone(),
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
                    },
                )
                .await;
            let status = match content {
                Ok(content) => content.value,
                Err(PortError::Cancelled(_)) => {
                    self.dismiss(run, &key).await?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match status {
                ConsumedPending::BranchChanged { .. } => self.dismiss(run, &key).await?,
                ConsumedPending::AlreadyConsumed => self.inner.revocations.finish_pending(&key),
                ConsumedPending::Appended {
                    entry,
                    intervening_human,
                } => {
                    self.inner.revocations.finish_pending(&key);
                    run.stream.committed(&entry, None)?;
                    if !intervening_human
                        && (run.kind == ChatThreadKind::Personal || item.mentions_agent)
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
                        let branch = self.thread_at(next_context, &run.thread, entry.seq).await?;
                        if self
                            .launch(follow, next, branch.thread, Some(&run.id))
                            .await
                            .is_ok()
                        {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Err(invalid(ValidationReason::BudgetExceeded))
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
