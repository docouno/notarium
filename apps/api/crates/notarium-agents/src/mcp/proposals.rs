use super::{
    EgressTarget, ToolCallContext, ToolName, ToolRegistry, corpus, derive_digest, derive_key,
    invalid,
    memory::{MemoryArgs, MemoryInput},
    note_tools, organize, session,
};
use notarium_core::{
    DomainError,
    auth::{PrincipalKind, ProposalHumanAccess, SpaceKind},
    error::{PortError, ValidationReason},
    ids::*,
    model::HistoryScope,
    ports::*,
    receipt::CommandIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const RULES_VERSION: u8 = 1;
pub(super) const MAX_DISPLAY_BYTES: usize = 32 * 1024;

impl ToolCallContext<'_> {
    pub(super) async fn fence_confirmed_effect(
        &self,
        scope: SpaceContext,
    ) -> Result<SpaceContext, PortError> {
        self.registry
            .control
            .fence_canonical_effect(self.auth.clone(), scope, CanonicalEffect::ConfirmedProposal)
            .await
    }
}

#[derive(Clone, Debug)]
pub struct PersonalToolInvocation {
    pub source: HistoryScope,
    pub thread: ChatThreadId,
    pub leaf: ThreadEntrySeq,
    pub owner: AccountContext,
}

#[derive(Clone, Debug)]
pub struct ConfirmProposedDiff {
    pub source: HistoryScope,
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
    pub proposal: ContentDigest,
}

pub(super) struct Draft {
    pub(crate) id: ContentDigest,
    pub(crate) envelope: String,
    pub(super) payload: Value,
}

pub(super) async fn prepare(
    call: &mut ToolCallContext<'_>,
    binding: &PersonalToolInvocation,
    call_id: &CommandKey,
    args: Value,
) -> Result<Draft, PortError> {
    personal_source(call, binding).await?;
    let owner = call
        .registry
        .control
        .revalidate_proposal_human(
            AccountContext::new(binding.owner.auth().clone(), call.budget()),
            ProposalHumanAccess::Write,
        )
        .await?;
    let planning = call.detached_human(owner);
    let action = match call.tool {
        ToolName::Link | ToolName::LinkMany => {
            ProposedAction::Links(organize::plan_links(&planning, call.tool, args).await?)
        }
        ToolName::RememberAboutUser | ToolName::RememberAboutProject => {
            ProposedAction::Memory(plan_memory(&planning, call.tool, args).await?)
        }
        _ => ProposedAction::Notes(note_tools::plan_proposal(&planning, call.tool, args).await?),
    };
    call.auth.taint().mark_external_read();
    let id = proposal_id(&binding.thread, call_id, &action)?;
    let preview = if let ProposedAction::Notes(notes) = &action {
        note_tools::preview_proposal(call, notes).await?
    } else {
        None
    };
    let envelope = encode(&ProposedDiffEnvelopeV1 {
        version: 1,
        rules: RULES_VERSION,
        proposal_id: id,
        source: binding.source.clone(),
        thread: binding.thread.clone(),
        call_id: call_id.clone(),
        tool: call.tool.name().into(),
        action,
    })?;
    let payload = json!({
        "outcome": "approvalRequired", "proposalId": id,
        "summary": "Review the proposed change and explicitly approve it in the chat.",
        "unifiedPreview": preview.as_deref().map(bounded_preview),
    });
    Ok(Draft {
        id,
        envelope,
        payload,
    })
}

pub(super) async fn confirm(
    registry: &ToolRegistry,
    account: AccountContext,
    request: ConfirmProposedDiff,
) -> Result<Value, PortError> {
    let (source, envelope, mut owner) = resolve_for_human(registry, account, &request).await?;
    let tool = owner.tool;
    let step_auth = owner.auth.clone();
    let step_budget = owner.budget();
    let deadline = owner.deadline;
    let authority = |scope: &HistoryScope, label: &'static str, ordinal: u16| {
        let identity = step_identity(&step_auth, scope, label, ordinal, request.proposal);
        let current_budget = CallBudget {
            remaining: deadline.saturating_duration_since(tokio::time::Instant::now()),
            ..step_budget.clone()
        };
        let ctx = SpaceContext::new(step_auth.clone(), scope.clone(), current_budget)?
            .with_confirmed_chat_step(source.witness().clone(), &identity)?;
        Ok((ctx, identity))
    };
    match envelope.action {
        ProposedAction::Notes(notes) => {
            note_tools::apply_proposal(&mut owner, notes, &authority).await
        }
        ProposedAction::Links(links) => {
            organize::apply_links(&owner, tool, &links, source.witness(), |ordinal, scope| {
                Ok(step_identity(
                    &step_auth,
                    scope,
                    "link",
                    ordinal,
                    request.proposal,
                ))
            })
            .await
        }
        ProposedAction::Memory(memory) => commit_memory(&owner, authority, memory).await,
    }
}

pub(super) async fn preview(
    registry: &ToolRegistry,
    account: AccountContext,
    request: ConfirmProposedDiff,
) -> Result<Value, PortError> {
    let (_, envelope, mut owner) = resolve_for_human(registry, account, &request).await?;
    let mut payload = json!({ "proposalId": request.proposal, "tool": owner.tool.name() });
    match &envelope.action {
        ProposedAction::Notes(notes) => {
            payload["change"] = note_tools::describe_proposal(&mut owner, notes).await?;
            payload["unifiedPreview"] =
                json!(note_tools::preview_proposal(&mut owner, notes).await?);
        }
        ProposedAction::Memory(plan) => {
            let current = registry
                .control
                .inspect_memory_target(owner.account(), plan.target.clone(), plan.category.clone())
                .await?;
            check_memory_target(plan, &current)?;
            payload["memory"] = json!({ "category": plan.category, "observation": plan.observation,
                "summary": plan.summary, "versionToken": plan.expected_revision });
        }
        ProposedAction::Links(links) => {
            payload["change"] = organize::describe_links(&owner, links).await?;
        }
    }
    Ok(payload)
}

async fn resolve_for_human<'a>(
    registry: &'a ToolRegistry,
    account: AccountContext,
    request: &ConfirmProposedDiff,
) -> Result<
    (
        CanonicalChatProposal,
        ProposedDiffEnvelopeV1,
        ToolCallContext<'a>,
    ),
    PortError,
> {
    let deadline = tokio::time::Instant::now() + account.budget.remaining;
    let budget = || CallBudget {
        remaining: deadline.saturating_duration_since(tokio::time::Instant::now()),
        ..account.budget.clone()
    };
    let verify = |access| {
        registry.control.revalidate_proposal_human(
            AccountContext::new(account.auth().clone(), budget()),
            access,
        )
    };
    let read_auth = verify(ProposalHumanAccess::ReadOnly).await?;
    let read_scope = SpaceContext::new(read_auth, request.source.clone(), budget())?;
    let source = registry
        .engine
        .read_chat_proposal(
            read_scope,
            ChatProposalRead {
                thread: request.thread.clone(),
                entry: request.entry,
            },
        )
        .await?;
    let envelope: ProposedDiffEnvelopeV1 = serde_json::from_str(&source.envelope)
        .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let tool = ToolName::parse(&envelope.tool)
        .filter(|tool| reversible(*tool))
        .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
    if envelope.version != 1
        || envelope.rules != RULES_VERSION
        || envelope.proposal_id != request.proposal
        || envelope.source != request.source
        || envelope.thread != request.thread
        || &envelope.call_id != source.witness().call_id()
        || source.witness().tool_name() != tool.name()
        || request.proposal
            != proposal_id(
                &request.thread,
                source.witness().call_id(),
                &envelope.action,
            )?
        || !action_matches(&envelope.action, tool)
    {
        return Err(DomainError::ResourceNotFound.into());
    }

    let write_auth = verify(ProposalHumanAccess::Write).await?;
    let owner = ToolCallContext::confirmed(registry, write_auth, budget(), tool, request.proposal)?;
    Ok((source, envelope, owner))
}

fn action_matches(action: &ProposedAction, tool: ToolName) -> bool {
    match action {
        ProposedAction::Notes(note) => note.tool_name() == tool,
        ProposedAction::Links(links) => match tool {
            ToolName::Link => links.len() == 1,
            ToolName::LinkMany => !links.is_empty() && links.len() <= 100,
            _ => false,
        },
        ProposedAction::Memory(memory) => matches!(
            (&memory.target, tool),
            (MemoryTarget::User { .. }, ToolName::RememberAboutUser)
                | (MemoryTarget::Project { .. }, ToolName::RememberAboutProject)
        ),
    }
}

fn bounded_preview(value: &str) -> &str {
    let mut end = value.len().min(MAX_DISPLAY_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn step_identity(
    auth: &notarium_core::auth::EngineAuthContext,
    scope: &HistoryScope,
    label: &str,
    ordinal: u16,
    proposal: ContentDigest,
) -> CommandIdentity {
    let fields = &[
        proposal.as_bytes().as_slice(),
        label.as_bytes(),
        &ordinal.to_be_bytes(),
    ];
    CommandIdentity {
        scope: scope.clone(),
        actor: auth.principal().clone(),
        key: derive_key("notarium.proposal.step-key.v1", fields),
        hash: derive_digest("notarium.proposal.step-digest.v1", fields),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposedDiffEnvelopeV1 {
    version: u8,
    rules: u8,
    proposal_id: ContentDigest,
    source: HistoryScope,
    thread: ChatThreadId,
    call_id: CommandKey,
    tool: String,
    action: ProposedAction,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "action", rename_all = "snake_case")]
enum ProposedAction {
    Notes(note_tools::PreparedNoteAction),
    Links(Vec<organize::LinkPlan>),
    Memory(PreparedMemory),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedMemory {
    scope: HistoryScope,
    target: MemoryTarget,
    note: NoteId,
    parent: FolderId,
    category: String,
    observation: String,
    summary: Option<String>,
    expected_revision: Option<RevisionId>,
}

fn reference(args: &Value, key: &str) -> Result<NoteId, PortError> {
    Ok(NoteId::parse(
        args[key]
            .as_str()
            .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?,
    )?)
}

pub(super) fn reversible(tool: ToolName) -> bool {
    matches!(
        tool,
        ToolName::CreateNote
            | ToolName::CreateNotes
            | ToolName::EditNote
            | ToolName::DeleteNote
            | ToolName::MoveNote
            | ToolName::RenameNote
            | ToolName::Link
            | ToolName::LinkMany
            | ToolName::RememberAboutUser
            | ToolName::RememberAboutProject
    )
}

pub(super) async fn needs_proposal(
    call: &ToolCallContext<'_>,
    args: &Value,
) -> Result<bool, PortError> {
    if !reversible(call.tool) {
        return Ok(false);
    }
    if call.auth.taint().is_tainted() {
        return Ok(true);
    }
    let pin = call
        .auth
        .pinned_write_space()
        .ok_or_else(|| invalid(ValidationReason::InvalidAuthority))?;
    let external = |space: &SpaceId| pin != space;
    let result = match call.tool {
        ToolName::CreateNote | ToolName::CreateNotes | ToolName::RememberAboutProject => {
            let project = args["project"]
                .as_str()
                .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?;
            let project = session::resolve_project(call, project).await?;
            external(&project.folder.space_id)
        }
        ToolName::EditNote
        | ToolName::DeleteNote
        | ToolName::MoveNote
        | ToolName::RenameNote
        | ToolName::Link => {
            let arg = if call.tool == ToolName::Link {
                "from"
            } else {
                "ref"
            };
            let (scope, _) = corpus::locate_note(call, &reference(args, arg)?).await?;
            external(&scope.scope().space_id)
        }
        ToolName::LinkMany => {
            let items = args["links"]
                .as_array()
                .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?;
            for item in items {
                let Ok(note) = reference(item, "from") else {
                    continue;
                };
                match corpus::locate_note(call, &note).await {
                    Ok((scope, _)) if external(&scope.scope().space_id) => return Ok(true),
                    Ok(_) => (),
                    Err(error) if corpus::hidden(&error) => (),
                    Err(error) => return Err(error),
                }
            }
            false
        }
        _ => false,
    };
    Ok(result || call.auth.taint().is_tainted())
}

pub(super) async fn personal_source(
    call: &ToolCallContext<'_>,
    binding: &PersonalToolInvocation,
) -> Result<(), PortError> {
    let PrincipalKind::AgentRun(active) = call.auth.kind() else {
        return Err(DomainError::AccessDenied.into());
    };
    if call.auth.pinned_write_space() != Some(&binding.source.space_id)
        || binding.owner.auth().principal() != call.auth.principal()
        || !matches!(call.target, EgressTarget::InAppProvider { .. })
    {
        return Err(DomainError::AccessDenied.into());
    }
    let space = call
        .registry
        .catalog
        .space(call.budget(), binding.source.space_id.clone())
        .await?;
    binding.source.check(&space.history)?;
    if space.space.kind != SpaceKind::Personal {
        return Err(DomainError::AccessDenied.into());
    }
    let scope = call.space(binding.source.clone())?;
    let branch = call
        .registry
        .engine
        .read_chat_context(
            scope,
            ChatRead {
                thread: binding.thread.clone(),
                leaf: binding.leaf,
                before: None,
                max_entries: PageLimit::new(1)?,
            },
        )
        .await?;
    if branch.thread.id != binding.thread
        || branch.thread.space != binding.source.space_id
        || branch.thread.kind != ChatThreadKind::Personal
        || &branch.thread.owner != call.auth.principal()
        || branch.thread.active_run.as_ref() != Some(active)
        || branch.thread.head != binding.leaf
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}

fn encode<T: Serialize>(value: &T) -> Result<String, PortError> {
    serde_json::to_string(value).map_err(|_| invalid(ValidationReason::InvalidState))
}

fn proposal_id(
    thread: &ChatThreadId,
    call: &CommandKey,
    action: &ProposedAction,
) -> Result<ContentDigest, PortError> {
    Ok(derive_digest(
        "notarium:proposed-diff:v1",
        &[
            thread.as_str().as_bytes(),
            call.as_str().as_bytes(),
            encode(action)?.as_bytes(),
        ],
    ))
}

async fn plan_memory(
    owner: &ToolCallContext<'_>,
    tool: ToolName,
    args: Value,
) -> Result<PreparedMemory, PortError> {
    let args = MemoryArgs::parse(args)?;
    let target = args.resolve_target(owner, tool).await?;
    let input = args.into_input(target);
    let current = input
        .inspect(owner.registry.control.as_ref(), owner.account())
        .await?;
    if let Some(expected) = &input.version_token
        && current.revision.as_ref() != Some(expected)
    {
        return Err(memory_conflict(current.revision));
    }
    Ok(PreparedMemory {
        scope: current.scope,
        target: input.target,
        category: input.category,
        note: current.resolved.note.note_id,
        parent: current.parent,
        observation: input.observation,
        summary: input.summary,
        expected_revision: current.revision,
    })
}

fn memory_conflict(revision: Option<RevisionId>) -> PortError {
    match revision {
        Some(current) => DomainError::RevisionConflict {
            current,
            lineage: None,
        }
        .into(),
        None => DomainError::ResourceNotFound.into(),
    }
}

async fn commit_memory(
    owner: &ToolCallContext<'_>,
    authority: impl Fn(
        &HistoryScope,
        &'static str,
        u16,
    ) -> Result<(SpaceContext, CommandIdentity), PortError>,
    plan: PreparedMemory,
) -> Result<Value, PortError> {
    let (scope, identity) = authority(&plan.scope, "append-memory", 0)?;
    let current = owner
        .registry
        .control
        .inspect_memory_target(owner.account(), plan.target.clone(), plan.category.clone())
        .await?;
    check_memory_target(&plan, &current)?;
    let input = MemoryInput {
        target: plan.target,
        category: plan.category,
        observation: plan.observation,
        summary: plan.summary,
        version_token: plan.expected_revision,
    };
    let mode = if input.version_token.is_some() {
        MemoryWriteMode::RequireExisting
    } else {
        MemoryWriteMode::RequireAbsent
    };
    let mutation = input.into_mutation(current.resolved, identity, mode)?;
    let scope = owner.fence_confirmed_effect(scope).await?;
    let committed = owner.registry.engine.append_memory(scope, mutation).await?;
    Ok(json!({
        "outcome": "applied",
        "noteId": committed.value.revision.note,
        "versionToken": committed.value.revision.revision,
    }))
}

fn check_memory_target(
    plan: &PreparedMemory,
    current: &MemoryTargetSnapshot,
) -> Result<(), PortError> {
    plan.scope.check(&current.scope)?;
    if current.resolved.note.note_id != plan.note || current.parent != plan.parent {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(())
}
