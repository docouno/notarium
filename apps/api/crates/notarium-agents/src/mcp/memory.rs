use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, DocClass},
    error::{PortError, ValidationReason},
    ids::RevisionId,
    model::{HistoryScope, NoteRef},
    ports::{
        AccountContext, AppendMemory, Committed, ControlPort, GetNote, MemoryAppendResult,
        MemoryTarget, MemoryTargetSnapshot, MemoryWriteMode, Mutation, Preconditions,
        ResolvedMemoryTarget, SpaceContext,
    },
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{EgressTarget, ToolCallContext, ToolName, decode, invalid, session};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MemoryArgs {
    project: Option<String>,
    observation: String,
    #[serde(default = "general_category")]
    category: String,
    summary: Option<String>,
    version_token: Option<RevisionId>,
}

#[derive(Deserialize, Serialize)]
struct MemoryRoute {
    scope: HistoryScope,
    target: MemoryTarget,
}

impl MemoryArgs {
    pub(super) fn parse(args: Value) -> Result<Self, PortError> {
        let mut args: Self = decode(args)?;
        args.observation = args.observation.trim().to_owned();
        if args.observation.is_empty() {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        Ok(args)
    }

    pub(super) async fn resolve_target(
        &self,
        call: &ToolCallContext<'_>,
        name: ToolName,
    ) -> Result<MemoryTarget, PortError> {
        match (name, self.project.as_deref()) {
            (ToolName::RememberAboutUser, None) => Ok(MemoryTarget::User {
                owner: call.account().auth().principal().clone(),
            }),
            (ToolName::RememberAboutProject, Some(handle)) => Ok(MemoryTarget::Project {
                folder: session::resolve_project(call, handle).await?.folder,
            }),
            _ => Err(invalid(ValidationReason::InvalidQuery)),
        }
    }

    pub(super) fn into_input(self, target: MemoryTarget) -> MemoryInput {
        MemoryInput {
            target,
            category: self.category,
            observation: self.observation,
            summary: self.summary,
            version_token: self.version_token,
        }
    }
}

fn general_category() -> String {
    "general".to_owned()
}

pub(super) struct MemoryInput {
    pub target: MemoryTarget,
    pub category: String,
    pub observation: String,
    pub summary: Option<String>,
    pub version_token: Option<RevisionId>,
}

impl MemoryInput {
    pub(super) async fn inspect(
        &self,
        control: &dyn ControlPort,
        account: AccountContext,
    ) -> Result<MemoryTargetSnapshot, PortError> {
        control
            .inspect_memory_target(account, self.target.clone(), self.category.clone())
            .await
    }

    pub(super) fn into_mutation(
        self,
        target: ResolvedMemoryTarget,
        identity: CommandIdentity,
        mode: MemoryWriteMode,
    ) -> Result<Mutation<AppendMemory>, PortError> {
        if target.target != self.target || target.category != self.category {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        Ok(Mutation {
            identity,
            preconditions: Preconditions {
                revision: self.version_token,
                ..Preconditions::default()
            },
            input: AppendMemory {
                target,
                text: self.observation,
                summary: self.summary,
                mode,
            },
        })
    }
}

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    let args = MemoryArgs::parse(args)?;
    // A retry must follow the authorized identity even if a project handle
    // has been reassigned since the original call.
    let route: MemoryRoute = call
        .journal("memory_route", || async {
            let target = args.resolve_target(call, name).await?;
            let snapshot = call
                .registry
                .control
                .inspect_memory_target(call.account(), target.clone(), args.category.clone())
                .await?;
            Ok(MemoryRoute {
                scope: snapshot.scope,
                target,
            })
        })
        .await?;
    let input = args.into_input(route.target);
    let snapshot = input
        .inspect(call.registry.control.as_ref(), call.account())
        .await?;
    route.scope.check(&snapshot.scope)?;
    let scope = call.space(snapshot.scope.clone())?;
    let target = snapshot.resolved.target.clone();
    let category = snapshot.resolved.category.clone();
    let note = snapshot.resolved.note.clone();
    let identity = call.command_identity(&snapshot.scope, "append_memory", 0);
    let mutation = input.into_mutation(
        snapshot.resolved,
        identity,
        MemoryWriteMode::CreateIfMissing,
    )?;
    let committed = call.registry.engine.append_memory(scope, mutation).await?;
    route.scope.check(committed.receipt.scope())?;
    if committed.value.revision.note != note.note_id {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if let EgressTarget::InAppProvider { .. } = &call.target {
        let scope = call.space(route.scope)?;
        if let Err(error) = admit_receipt_metadata(call, scope, &target, &note, &committed).await {
            tracing::debug!(code = error.code(), "memory receipt metadata unavailable");
            return Ok(json!({
                "outcome": committed.value.outcome,
                "summaryUpdated": committed.value.summary_updated,
            }));
        }
    }
    let result = committed.value;
    Ok(json!({
        "noteId": result.revision.note,
        "versionToken": result.revision.revision,
        "category": category,
        "outcome": result.outcome,
        "summaryUpdated": result.summary_updated,
    }))
}

async fn admit_receipt_metadata(
    call: &mut ToolCallContext<'_>,
    scope: SpaceContext,
    target: &MemoryTarget,
    note: &NoteRef,
    committed: &Committed<MemoryAppendResult>,
) -> Result<(), PortError> {
    let target_project = match target {
        MemoryTarget::User { .. } => None,
        MemoryTarget::Project { folder } => Some(folder.clone()),
    };
    let primary = match &call.target {
        EgressTarget::InAppProvider {
            primary_project, ..
        } => primary_project.as_ref(),
        EgressTarget::ExternalMcp => return Err(DomainError::AccessDenied.into()),
    };
    let project = target_project.clone().or_else(|| {
        primary
            .filter(|project| project.space_id == note.space_id)
            .cloned()
    });
    let selection = call
        .provider_selection(&scope, project.clone())
        .await?
        .ok_or(DomainError::AccessDenied)?;
    let revision = &committed.value.revision.revision;
    let doc = call
        .registry
        .engine
        .get_note(
            scope.clone(),
            GetNote {
                note: note.note_id.clone(),
                revision: Some(revision.clone()),
                causal: CausalBasis::Exact(ReceiptSet::new([committed.receipt.clone()])?),
            },
        )
        .await?
        .document;
    if doc.reference() != note || doc.revision() != revision || doc.class() != DocClass::AgentMemory
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if target_project
        .as_ref()
        .is_some_and(|project| !doc.in_project(project))
        || selection
            .project_only
            .as_ref()
            .is_some_and(|project| !doc.in_project(project))
    {
        return Err(DomainError::AccessDenied.into());
    }
    let proof =
        ClassEgressFence::provider_note_metadata(&doc.metadata(), scope.auth(), &selection.policy)?;
    call.record_origin(proof, project)
}
