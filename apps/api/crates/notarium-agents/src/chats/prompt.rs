use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, ProviderMessage},
    error::{PortError, ValidationReason},
    ids::{ChatThreadId, ThreadEntrySeq},
    model::FolderRef,
    ports::{
        ChatBranch, ChatContentRead, ChatEntryKind, ChatPort, ChatProvenance, ChatRead,
        CompletionMessage, CompletionRole, HydratedChatEntry, PageLimit, ProviderInstruction,
        ProviderSelection, ProviderToolCallId, SpaceContext,
    },
};

const HISTORY_WINDOW: u16 = 200;

pub(crate) struct Prompt {
    pub messages: Vec<CompletionMessage>,
    pub projects: Vec<FolderRef>,
    pub history_entries: usize,
}

impl Prompt {
    pub(crate) fn provenance(&self) -> Result<ChatProvenance, PortError> {
        let mut origins = Vec::new();
        for part in self.messages.iter().flat_map(|message| &message.parts) {
            let origin = part.origin();
            if !origins.contains(&origin) {
                if origins.len() == ChatProvenance::MAX_ORIGINS {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                origins.push(origin);
            }
        }
        let proof = ChatProvenance {
            origins,
            projects: self.projects.clone(),
        };
        let encoded =
            serde_json::to_vec(&proof).map_err(|_| invalid(ValidationReason::InvalidState))?;
        if encoded.len() > ChatProvenance::MAX_BYTES {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        Ok(proof)
    }
}

pub(crate) async fn load_history(
    engine: &dyn ChatPort,
    ctx: &SpaceContext,
    thread: &ChatThreadId,
    leaf: ThreadEntrySeq,
    selection: &ProviderSelection,
) -> Result<(ChatBranch, Vec<CompletionMessage>), PortError> {
    let mut branch = engine
        .read_chat_context(
            ctx.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf,
                before: None,
                max_entries: PageLimit::new(HISTORY_WINDOW)?,
            },
        )
        .await?;
    if branch.thread.id != *thread || branch.thread.space != ctx.scope().space_id {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if branch.next_ancestor.is_some() {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    branch.entries.sort_by_key(|entry| entry.seq);
    let ids: Vec<_> = branch
        .entries
        .iter()
        .filter(|entry| entry.kind != ChatEntryKind::Redacted)
        .map(|entry| entry.seq)
        .collect();
    let hydrated = if ids.is_empty() {
        Vec::new()
    } else {
        engine
            .read_chat_contents(
                ctx.clone(),
                ChatContentRead {
                    thread: thread.clone(),
                    leaf,
                    entries: ids,
                },
            )
            .await?
    };
    let messages = assemble(ctx, &branch, hydrated, selection)?;
    Ok((branch, messages))
}

fn assemble(
    ctx: &SpaceContext,
    branch: &ChatBranch,
    hydrated: Vec<HydratedChatEntry>,
    selection: &ProviderSelection,
) -> Result<Vec<CompletionMessage>, PortError> {
    let mut content = BTreeMap::new();
    for item in hydrated {
        if item.seq != item.content.entry
            || item.content.thread != branch.thread.id
            || item.content.space.id != branch.thread.space
            || content.insert(item.seq, item).is_some()
        {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
    }
    let typed = |item: HydratedChatEntry| -> Result<ProviderMessage, PortError> {
        let part = ProviderMessage::Chat(ClassEgressFence::chat(
            item.content,
            ctx.auth(),
            &selection.policy,
        )?);
        if selection
            .project_only
            .as_ref()
            .is_some_and(|project| !part.in_project(project))
        {
            return Err(DomainError::AccessDenied.into());
        }
        Ok(part)
    };
    let mut output = Vec::new();
    let mut entries = branch.entries.iter().peekable();
    while let Some(entry) = entries.next() {
        let item = content.remove(&entry.seq);
        match &entry.kind {
            ChatEntryKind::Redacted | ChatEntryKind::Tool { .. } => (),
            ChatEntryKind::Compaction | ChatEntryKind::Human => {
                let item = item.ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
                let role = if entry.kind == ChatEntryKind::Human {
                    CompletionRole::User
                } else {
                    CompletionRole::Assistant
                };
                output.push(message(role, typed(item)?));
            }
            ChatEntryKind::Model => {
                let mut model = item.ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
                let calls = std::mem::take(&mut model.tool_calls);
                let expected: BTreeSet<_> = calls.iter().map(|call| call.id.as_str()).collect();
                let mut results = BTreeMap::new();
                while let Some(candidate) = entries.peek() {
                    let ChatEntryKind::Tool { call_id } = &candidate.kind else {
                        break;
                    };
                    let candidate = entries.next().expect("peeked tool result");
                    let item = content
                        .remove(&candidate.seq)
                        .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
                    if expected.contains(call_id.as_str())
                        && candidate.run == entry.run
                        && results.insert(call_id.as_str(), item).is_some()
                    {
                        return Err(invalid(ValidationReason::SourceMismatch));
                    }
                }
                let mut assistant = message(CompletionRole::Assistant, typed(model)?);
                if results.len() != expected.len() || calls.len() != expected.len() {
                    output.push(assistant);
                    continue;
                }
                let paired = calls
                    .iter()
                    .map(|call| {
                        let item = results
                            .remove(call.id.as_str())
                            .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
                        let mut response = message(CompletionRole::Tool, typed(item)?);
                        response.result_for =
                            Some(ProviderToolCallId::new(call.id.as_str().to_owned())?);
                        Ok(response)
                    })
                    .collect::<Result<Vec<_>, PortError>>()?;
                assistant.tool_calls = calls;
                output.push(assistant);
                output.extend(paired);
            }
        }
    }
    if !content.is_empty() {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(output)
}

pub(crate) fn system_prompt(
    text: String,
    parts: Vec<ProviderMessage>,
) -> Result<CompletionMessage, PortError> {
    Ok(CompletionMessage {
        role: CompletionRole::System,
        instruction: Some(ProviderInstruction::from_orchestrator(text)?),
        parts,
        tool_calls: vec![],
        result_for: None,
    })
}

fn message(role: CompletionRole, part: ProviderMessage) -> CompletionMessage {
    CompletionMessage {
        role,
        instruction: None,
        parts: vec![part],
        tool_calls: vec![],
        result_for: None,
    }
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}
