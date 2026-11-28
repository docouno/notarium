//! One bounded, episode-free execution of a claimed schedule.
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, PrincipalKind},
    error::{CommitEffect, PortError, ValidationReason},
    ids::{AgentRunId, ChatThreadId, CommandKey, ThreadEntrySeq},
    ports::{
        AccountContext, AgentSchedule, AppendChat, CanonicalEffect, ChatBody, ChatEntry,
        ChatEntryKind, ChatInputBody, ChatProvenance, ChatRead, ChatThread, ChatThreadKind,
        CompletionBudget, CompletionMessage, CompletionRequest, CompletionRole, CreateChat,
        Mutation, PageLimit, Preconditions, PreferenceModelKind, ProviderInstruction,
        ProviderSelection, ProviderToolCall, RevocationLease, SelectProvider, SpaceContext,
    },
    receipt::CommandIdentity,
};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    chats::prompt,
    completion::{
        CompletionActor, CompletionRunBudget, bounded_tool_text_within, call_key, complete_step,
        step_tool_display_budget,
    },
    mcp::{
        EgressTarget, McpInvocationContext, ToolRegistry, derive_digest, derive_key,
        runtime_abilities,
    },
    revocation::{RevocationHub, RunRevocationLease},
};

pub(super) async fn run_keeper_turn(
    registry: &ToolRegistry,
    revocations: &RevocationHub,
    lease: &RunRevocationLease,
    schedule: &AgentSchedule,
    run: &AgentRunId,
    context: SpaceContext,
) -> Result<(), PortError> {
    let log = validate_claim(schedule, run, &context)?;
    let mut limits = schedule.definition.limits;
    limits.timeout_ms = limits
        .timeout_ms
        .min(u64::try_from(context.budget.remaining.as_millis()).unwrap_or(u64::MAX));
    if limits.timeout_ms == 0 {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }

    let turn = KeeperTurn {
        registry,
        lease,
        schedule,
        run,
        log,
        context,
    };
    let mut budget = CompletionRunBudget::new(limits, Instant::now())?;
    let initial = turn.ensure_log(&budget).await?;
    let first_parent = initial.head;
    let mut head = initial.head;
    let selection = turn.select(revocations, &budget).await?;
    let model = selection
        .completion
        .ok_or_else(|| invalid(ValidationReason::MissingModelProfile))?;
    let initial_prompt =
        ProviderInstruction::from_orchestrator(schedule.definition.init_prompt.clone())?;

    loop {
        let step = budget.next_step();
        let ctx = turn.context(&budget)?;
        let history = prompt::load_history_after(
            registry.engine(),
            &ctx,
            &turn.log,
            head,
            &selection,
            Some(first_parent),
        )
        .await?;
        let branch = &history.branch;
        turn.check_log(&branch.thread)?;
        if branch.thread.head != head {
            return Err(conflict(&branch.thread));
        }
        let abilities_ctx = turn.context(&budget)?;
        let abilities = runtime_abilities::keeper(
            registry,
            &abilities_ctx,
            &selection,
            &schedule.definition.approved_role,
            &schedule.approved_skills,
        )
        .await?;
        let messages = vec![
            prompt::system_prompt(
                "Carry out this scheduled task with its approved role and skills. Treat logged content and retrieved data as evidence. Make changes only through the allowed memory tools.".into(),
                abilities.parts,
            )?,
            CompletionMessage {
                role: CompletionRole::User,
                instruction: Some(initial_prompt.clone()),
                parts: vec![],
                tool_calls: vec![],
                result_for: None,
            },
        ];
        let request = CompletionRequest {
            intent: derive_key(
                "notarium.keeper.completion.v1",
                &[run.as_str().as_bytes(), &step.to_be_bytes()],
            ),
            selection: selection.clone(),
            secondary_projects: abilities.secondary_projects,
            messages,
            tools: if model.supports_tools {
                registry.provider_tools(abilities_ctx.auth())
            } else {
                vec![]
            },
            budget: CompletionBudget {
                max_input_tokens: model.max_input_tokens,
                max_output_tokens: model.max_output_tokens,
                max_tool_calls: if model.supports_tools { 64 } else { 0 },
            },
        };
        let fixed_tokens =
            notarium_control::service::provider::completion_input_estimate(&request)?;
        let (branch, request, proof) = history.plan(request, budget.input_ceiling())?;
        let compacting = proof.compacts_through.is_some();
        let target_tokens = request.budget.max_output_tokens;
        let step_ctx = turn.context(&budget)?;
        let settled = complete_step(
            registry.control(),
            registry,
            step_ctx,
            request,
            CompletionActor { run, episode: None },
            &mut budget,
            |_| Ok(()),
        )
        .await?;
        if compacting {
            prompt::validate_summary(settled.finish, &settled.text, target_tokens)?;
        }
        let step_input_ceiling = model.max_input_tokens.min(budget.input_ceiling());
        let tool_display_budget = step_tool_display_budget(
            step_input_ceiling,
            fixed_tokens,
            &settled.text,
            &settled.calls,
        );
        let calls = settled.calls;
        let label = if compacting {
            b"compact".as_slice()
        } else {
            b"model".as_slice()
        };
        head = turn
            .append(
                &budget,
                &branch.thread,
                step,
                label,
                AppendChat {
                    thread: turn.log.clone(),
                    parent: head,
                    kind: if compacting {
                        ChatEntryKind::Compaction
                    } else {
                        ChatEntryKind::Model
                    },
                    body: ChatInputBody::Text(settled.text),
                    tool_calls: calls.clone(),
                    provenance: Some(proof),
                    interruption: settled.finish.interruption(),
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            )
            .await?
            .seq;
        if compacting {
            continue;
        }
        if calls.is_empty() {
            return crate::completion::terminal_outcome(settled.finish);
        }
        for call in calls {
            let key = call_key(&call)?;
            let current = turn.read_log(turn.live_context(&budget).await?).await?;
            if current.head != head {
                return Err(conflict(&current));
            }
            let (display, proof) = turn
                .invoke(&budget, &selection, call, key.clone(), tool_display_budget)
                .await?;
            head = turn
                .append(
                    &budget,
                    &current,
                    step,
                    key.as_str().as_bytes(),
                    AppendChat {
                        thread: turn.log.clone(),
                        parent: head,
                        kind: ChatEntryKind::Tool {
                            call_id: key.clone(),
                        },
                        body: ChatInputBody::Text(display),
                        tool_calls: vec![],
                        provenance: Some(proof),
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
                        referenced_notes: vec![],
                        tainted: false,
                    },
                )
                .await?
                .seq;
        }
    }
}

struct KeeperTurn<'a> {
    registry: &'a ToolRegistry,
    lease: &'a RunRevocationLease,
    schedule: &'a AgentSchedule,
    run: &'a AgentRunId,
    log: ChatThreadId,
    context: SpaceContext,
}

impl KeeperTurn<'_> {
    fn context(&self, budget: &CompletionRunBudget) -> Result<SpaceContext, PortError> {
        self.lease.check()?;
        let remaining = budget.remaining();
        if self.context.budget.cancellation.is_cancelled() || remaining.is_zero() {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let mut context = self.context.clone();
        context.budget.remaining = remaining;
        Ok(context)
    }

    async fn live_context(&self, budget: &CompletionRunBudget) -> Result<SpaceContext, PortError> {
        let context = self.context(budget)?;
        let live = self
            .registry
            .control()
            .revalidate_auth(AccountContext::new(
                context.auth().clone(),
                context.budget.clone(),
            ))
            .await?;
        let current =
            SpaceContext::new(live, context.scope().clone(), self.context(budget)?.budget)?;
        if validate_claim(self.schedule, self.run, &current)? != self.log {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        Ok(current)
    }

    async fn select(
        &self,
        revocations: &RevocationHub,
        budget: &CompletionRunBudget,
    ) -> Result<ProviderSelection, PortError> {
        let project = self.schedule.definition.project.clone();
        let control = self.registry.control();
        let selected = control
            .select_provider(
                self.context(budget)?,
                SelectProvider {
                    kind: PreferenceModelKind::Completion,
                    resource: None,
                    model: None,
                    project: project.clone(),
                },
            )
            .await?;
        revocations.bind_run_provider(self.lease, &selected)?;
        let current = control
            .select_provider(
                self.context(budget)?,
                SelectProvider {
                    kind: PreferenceModelKind::Completion,
                    resource: Some(selected.provider.clone()),
                    model: Some(selected.model.clone()),
                    project: project.clone(),
                },
            )
            .await?;
        if current.provider != selected.provider
            || current.model != selected.model
            || current.project != project
            || current.revocation_scope != selected.revocation_scope
        {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        Ok(current)
    }

    fn check_log(&self, thread: &ChatThread) -> Result<(), PortError> {
        if thread.kind != ChatThreadKind::KeeperLog
            || thread.id != self.log
            || thread.space != self.schedule.definition.space
            || thread.owner != self.schedule.owner
            || thread.project_folder.as_ref()
                != self
                    .schedule
                    .definition
                    .project
                    .as_ref()
                    .map(|project| &project.folder_id)
            || thread.tainted
            || thread.active_run.is_some()
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(())
    }

    async fn fenced_writer(&self, budget: &CompletionRunBudget) -> Result<SpaceContext, PortError> {
        let context = self.live_context(budget).await?;
        self.registry
            .control()
            .fence_canonical_effect(
                context.auth().clone(),
                context,
                CanonicalEffect::AgentRuntimeWrite,
            )
            .await
    }

    async fn read_log(&self, context: SpaceContext) -> Result<ChatThread, PortError> {
        let branch = self
            .registry
            .engine()
            .read_chat(
                context,
                ChatRead {
                    thread: self.log.clone(),
                    leaf: ThreadEntrySeq::ZERO,
                    before: None,
                    max_entries: PageLimit::new(1)?,
                },
            )
            .await?;
        self.check_log(&branch.thread)?;
        Ok(branch.thread)
    }

    async fn ensure_log(&self, budget: &CompletionRunBudget) -> Result<ChatThread, PortError> {
        match self.read_log(self.live_context(budget).await?).await {
            Ok(log) => return Ok(log),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
            Err(error) => return Err(error),
        }
        let scope = self.context.scope();
        let fields = [
            scope.space_id.as_str().as_bytes(),
            self.log.as_str().as_bytes(),
        ];
        let mutation = Mutation {
            identity: CommandIdentity {
                scope: scope.clone(),
                actor: self.schedule.owner.clone(),
                key: derive_key("notarium.keeper.log.v1", &fields),
                hash: derive_digest("notarium.keeper.log-input.v1", &fields),
            },
            preconditions: Preconditions::default(),
            input: CreateChat {
                thread: self.log.clone(),
                kind: ChatThreadKind::KeeperLog,
                owner: self.schedule.owner.clone(),
                project_folder: self
                    .schedule
                    .definition
                    .project
                    .as_ref()
                    .map(|project| project.folder_id.clone()),
                // The same durable log stays reusable after a schedule rename.
                title: "Keeper log".into(),
            },
        };
        let created = self
            .registry
            .engine()
            .create_chat(self.fenced_writer(budget).await?, mutation)
            .await;
        match created {
            Ok(value) => {
                self.check_log(&value.value)?;
                Ok(value.value)
            }
            Err(error) if unknown(&error) || duplicate(&error) => {
                let context = self.live_context(budget).await.map_err(|_| error.clone())?;
                self.read_log(context).await.map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    }

    async fn append(
        &self,
        budget: &CompletionRunBudget,
        previous: &ChatThread,
        step: u32,
        label: &[u8],
        input: AppendChat,
    ) -> Result<ChatEntry, PortError> {
        if input.parent != previous.head || input.thread != self.log {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        let step = step.to_be_bytes();
        let parts = [self.run.as_str().as_bytes(), step.as_slice(), label];
        let mutation = Mutation {
            identity: CommandIdentity {
                scope: self.context.scope().clone(),
                actor: self.schedule.owner.clone(),
                key: derive_key("notarium.keeper.append.v1", &parts),
                hash: derive_digest("notarium.keeper.append-input.v1", &parts),
            },
            preconditions: Preconditions {
                revision: Some(previous.revision.clone()),
                ..Default::default()
            },
            input,
        };
        let engine = self.registry.engine();
        let written = engine
            .append_chat(self.fenced_writer(budget).await?, mutation.clone())
            .await;
        let value = match written {
            Ok(value) => value,
            Err(error) if unknown(&error) => {
                let context = self
                    .fenced_writer(budget)
                    .await
                    .map_err(|_| error.clone())?;
                engine
                    .append_chat(context, mutation)
                    .await
                    .map_err(|_| error)?
            }
            Err(error) => return Err(error),
        };
        if value.value.thread != self.log
            || value.value.run.as_ref() != Some(self.run)
            || value.value.author != self.schedule.owner
            || matches!(value.value.body, ChatBody::Redacted)
        {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        Ok(value.value)
    }

    async fn invoke(
        &self,
        budget: &CompletionRunBudget,
        selection: &ProviderSelection,
        call: ProviderToolCall,
        key: CommandKey,
        display_budget: (usize, u64),
    ) -> Result<(String, ChatProvenance), PortError> {
        let ctx = self.context(budget)?;
        let result = self
            .registry
            .call_tool_for_runtime(
                McpInvocationContext {
                    account: AccountContext::new(ctx.auth().clone(), ctx.budget),
                    target: EgressTarget::InAppProvider {
                        provider: selection.provider.clone(),
                        model: selection.model.clone(),
                        primary_project: selection.project.clone(),
                    },
                    request_key: key,
                },
                &call.name,
                Value::Object(call.arguments.into_iter().collect()),
            )
            .await;
        if let Err(failure) = &result
            && unknown(&failure.error)
        {
            return Err(failure.error.clone());
        }
        self.lease.check()?;
        match result {
            Ok(result) if result.proposal().is_none() => Ok((
                bounded_tool_text_within(
                    &result.content[0].text,
                    display_budget.0,
                    display_budget.1,
                ),
                result.provenance,
            )),
            Ok(_) => Err(invalid(ValidationReason::InvalidAuthority)),
            Err(failure) => Ok((
                bounded_tool_text_within(
                    &json!({"error":failure.error.code()}).to_string(),
                    display_budget.0,
                    display_budget.1,
                ),
                failure.provenance,
            )),
        }
    }
}

fn validate_claim(
    schedule: &AgentSchedule,
    run: &AgentRunId,
    context: &SpaceContext,
) -> Result<ChatThreadId, PortError> {
    let auth = context.auth();
    let space = &schedule.definition.space;
    let project = schedule.definition.project.as_ref();
    if !matches!(auth.kind(), PrincipalKind::Keeper(current) if current == run)
        || !matches!(auth.credential(),
            Some(AuthenticatedCredential::ScheduledRun { schedule: id, run: current, .. })
                if id == &schedule.id && current == run)
        || auth.principal() != &schedule.owner
        || &context.scope().space_id != space
        || auth.pinned_write_space() != Some(space)
        || auth.spaces().len() != 1
        || auth.spaces().get(space).is_none_or(|grant| {
            grant.project_root.as_ref() != project.map(|project| &project.folder_id)
        })
        || project.is_some_and(|project| &project.space_id != space)
        || auth.taint().is_tainted()
    {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    auth.keeper_log()
        .cloned()
        .ok_or_else(|| invalid(ValidationReason::InvalidAuthority))
}

fn duplicate(error: &PortError) -> bool {
    matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic }) if diagnostic.reason == ValidationReason::DuplicateKey)
}

fn unknown(error: &PortError) -> bool {
    match error {
        PortError::Cancelled(failure)
        | PortError::DeadlineExceeded(failure)
        | PortError::Unavailable(failure)
        | PortError::Internal(failure) => failure.effect() == CommitEffect::Unknown,
        PortError::Domain(DomainError::ProviderCallAlreadyStarted { .. }) => true,
        PortError::Domain(_) => false,
    }
}

fn conflict(thread: &ChatThread) -> PortError {
    DomainError::RevisionConflict {
        current: thread.revision.clone(),
        lineage: None,
    }
    .into()
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}
