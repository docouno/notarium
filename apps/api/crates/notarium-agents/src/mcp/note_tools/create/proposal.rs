use notarium_core::{
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, NoteId},
    model::HistoryScope,
    ports::{CreateNote, Mutation, Preconditions},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    BatchInput, CreateInput, CreateProject, PreparedDraft, ToolCallContext,
    batch_operational_error, decode, invalid, observe_project, prepare_carrier, project_placement,
    receipt_result,
};
use crate::mcp::{
    ToolName,
    note_tools::proposal::{ConfirmedStep, Destination, assert_absent_id, observe_destination},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::mcp) struct ProposedCreates {
    project: CreateProject,
    batch: bool,
    steps: Vec<CreateStep>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum CreateStep {
    Ready(Box<ProposedDraft>),
    Invalid { code: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProposedDraft {
    note: NoteId,
    destination: Destination,
    slug: String,
    folder_page: bool,
    carrier: String,
    body_bytes: usize,
    body_hash: ContentDigest,
}

impl ProposedCreates {
    pub(in crate::mcp) fn scope(&self) -> &HistoryScope {
        &self.project.scope
    }

    pub(in crate::mcp) fn tool_name(&self) -> ToolName {
        if self.batch {
            ToolName::CreateNotes
        } else {
            ToolName::CreateNote
        }
    }
}

pub(in crate::mcp::note_tools) async fn describe(
    reviewer: &mut ToolCallContext<'_>,
    plan: &ProposedCreates,
) -> Result<Value, PortError> {
    let placement = project_placement(reviewer, plan.project.clone(), false).await?;
    let mut notes = Vec::with_capacity(plan.steps.len());
    for (index, step) in plan.steps.iter().enumerate() {
        let detail = match step {
            CreateStep::Ready(draft) => {
                let destination = draft
                    .destination
                    .describe(reviewer, &placement.write_scope, DocClass::UserDoc)
                    .await?;
                json!({
                    "index":index, "noteId":draft.note, "destination":destination,
                    "fileName":format!("{}.md", draft.slug), "folderPage":draft.folder_page,
                    "content":draft.carrier,
                })
            }
            CreateStep::Invalid { code } => json!({ "index":index, "error":code }),
        };
        notes.push(detail);
    }
    Ok(
        json!({ "spaceId":plan.project.scope.space_id, "projectFolder":plan.project.reference.folder_id, "notes":notes }),
    )
}

/// Validate create proposal input shape and envelope-size prebounds without
/// touching canonical note content. Returns whether any draft declares links
/// that will probe target notes during planning.
pub(in crate::mcp::note_tools) fn preflight_input(
    tool: ToolName,
    args: &Value,
) -> Result<bool, PortError> {
    let max_body = notarium_core::ports::AppendChat::MAX_STRUCTURED_BODY_BYTES - 256;
    match tool {
        ToolName::CreateNote => {
            let input: CreateInput = decode(args.clone())?;
            if input.draft.body.len() > max_body {
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
            super::validate_draft_syntax(&input.draft, input.folder_page)
        }
        ToolName::CreateNotes => {
            let input: BatchInput = decode(args.clone())?;
            let mut total_body = 0usize;
            let mut any_ready = false;
            let mut has_links = false;
            for raw in input.notes {
                if let Ok(draft) = decode::<super::NoteDraft>(raw) {
                    total_body = total_body.saturating_add(draft.body.len());
                    if let Ok(item_links) = super::validate_draft_syntax(&draft, false) {
                        any_ready = true;
                        has_links |= item_links;
                    }
                }
            }
            if total_body > max_body {
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
            if !any_ready {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
            Ok(has_links)
        }
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

pub(in crate::mcp::note_tools) async fn prepare(
    owner: &ToolCallContext<'_>,
    provider: &ToolCallContext<'_>,
    tool: ToolName,
    args: Value,
) -> Result<ProposedCreates, PortError> {
    let (project, drafts, batch, folder_page) = match tool {
        ToolName::CreateNote => {
            let input: CreateInput = decode(args)?;
            (
                input.project,
                vec![Ok(input.draft)],
                false,
                input.folder_page,
            )
        }
        ToolName::CreateNotes => {
            let input: BatchInput = decode(args)?;
            (
                input.project,
                input.notes.into_iter().map(decode).collect(),
                true,
                false,
            )
        }
        _ => return Err(invalid(ValidationReason::InvalidQuery)),
    };
    let project = observe_project(owner, &project).await?;
    let place = project_placement(owner, project, false).await?;
    let mut draft_plans = Vec::with_capacity(drafts.len());
    for (index, draft) in drafts.into_iter().enumerate() {
        let plan = async {
            let draft = PreparedDraft::new(owner, &place, draft?, folder_page, index as u16, None)?;
            assert_absent_id(owner, &place.write_scope, &draft.note).await?;
            let destination = observe_destination(
                owner,
                &place.write_scope,
                Some(place.project.reference.folder_id.clone()),
                &draft.relative_path,
                DocClass::UserDoc,
            )
            .await?;
            Ok::<_, PortError>((draft, destination))
        }
        .await;
        draft_plans.push(plan);
    }
    let mut steps = Vec::with_capacity(draft_plans.len());
    for plan in draft_plans {
        let proposed = async {
            let (draft, destination) = plan?;
            // Approval governs these exact create bytes. A title reference
            // stays authored until the target is known to exist.
            let carrier = prepare_carrier(
                owner,
                Some(provider),
                &place.read_scope,
                Some(&place.project.reference.folder_id),
                &draft,
            )
            .await?;
            Ok::<_, PortError>(ProposedDraft {
                note: draft.note,
                destination,
                slug: draft.slug,
                folder_page: draft.folder_page,
                carrier,
                body_bytes: draft.draft.body.len(),
                body_hash: notarium_syntax::content_digest(&draft.draft.body),
            })
        }
        .await;
        steps.push(match proposed {
            Ok(draft) => CreateStep::Ready(Box::new(draft)),
            Err(PortError::Domain(error))
                if batch && !matches!(error, notarium_core::DomainError::RateLimited { .. }) =>
            {
                CreateStep::Invalid {
                    code: error.code().to_owned(),
                }
            }
            Err(error) => return Err(error),
        });
    }
    if !steps
        .iter()
        .any(|step| matches!(step, CreateStep::Ready(_)))
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(ProposedCreates {
        project: place.project,
        batch,
        steps,
    })
}

async fn apply_one(
    owner: &mut ToolCallContext<'_>,
    project: &CreateProject,
    draft: ProposedDraft,
    step: &ConfirmedStep<'_>,
    index: u16,
    committed_any: &mut bool,
) -> Result<Value, PortError> {
    const LABEL: &str = "notarium.mcp.confirmed-create-notes-batch.v1";
    let creates_folder = draft.destination.exact().is_none();
    let (folder_ctx, folder_identity) = step(&project.scope, "create_destination", index)
        .map_err(|error| batch_operational_error(LABEL, error, *committed_any))?;
    let folder_scope = folder_ctx
        .restrict_to_project(&project.reference)
        .map_err(|error| batch_operational_error(LABEL, error.into(), *committed_any))?;
    let parent = draft
        .destination
        .apply(owner, folder_scope, folder_identity, None)
        .await
        .map_err(|error| batch_operational_error(LABEL, error, *committed_any))?;
    if creates_folder {
        *committed_any = true;
    }
    let (write_ctx, identity) = step(&project.scope, "create_note", index)
        .map_err(|error| batch_operational_error(LABEL, error, *committed_any))?;
    let scope = write_ctx
        .restrict_to_project(&project.reference)
        .map_err(|error| batch_operational_error(LABEL, error.into(), *committed_any))?;
    let bound = draft
        .destination
        .bind(scope.clone(), None)
        .map_err(|error| batch_operational_error(LABEL, error, *committed_any))?;
    let leased = owner
        .fence_confirmed_effect(bound)
        .await
        .map_err(|error| batch_operational_error(LABEL, error, *committed_any))?;
    let committed = owner
        .registry
        .engine
        .create_note(
            leased,
            Mutation {
                identity,
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: draft.note.clone(),
                    parent: Some(parent.folder_id.clone()),
                    slug: draft.slug,
                    class: DocClass::UserDoc,
                    carrier: draft.carrier,
                    folder_page: draft.folder_page,
                },
            },
        )
        .await
        .map_err(|error| batch_operational_error(LABEL, error, *committed_any))?;
    *committed_any = true;
    let mut result = receipt_result(owner, scope, &draft.note, committed, "created")
        .await
        .map_err(|error| batch_operational_error(LABEL, error, true))?;
    if result.get("noteId").is_some() {
        result["bodyBytes"] = json!(draft.body_bytes);
        result["bodyHash"] = json!(draft.body_hash);
        if draft.folder_page {
            result["folderPage"] =
                json!({"status":"present", "folderId":parent.folder_id, "noteId":draft.note});
        }
    }
    Ok(result)
}

pub(in crate::mcp::note_tools) async fn apply(
    owner: &mut ToolCallContext<'_>,
    plan: ProposedCreates,
    step: &ConfirmedStep<'_>,
) -> Result<Value, PortError> {
    if !plan.batch {
        let [CreateStep::Ready(draft)]: [CreateStep; 1] = plan
            .steps
            .try_into()
            .map_err(|_| invalid(ValidationReason::InvalidState))?
        else {
            return Err(invalid(ValidationReason::InvalidState));
        };
        let mut committed_any = false;
        return apply_one(owner, &plan.project, *draft, step, 0, &mut committed_any).await;
    }
    const LABEL: &str = "notarium.mcp.confirmed-create-notes-batch.v1";
    let mut results = Vec::with_capacity(plan.steps.len());
    let mut committed_any = false;
    for (index, row) in plan.steps.into_iter().enumerate() {
        let result = match row {
            CreateStep::Ready(draft) => {
                apply_one(
                    owner,
                    &plan.project,
                    *draft,
                    step,
                    index as u16,
                    &mut committed_any,
                )
                .await
            }
            CreateStep::Invalid { code } => {
                results.push(json!({"index":index, "ok":false, "error":code}));
                continue;
            }
        };
        match result {
            Ok(mut value) => {
                committed_any = true;
                value["index"] = json!(index);
                value["ok"] = json!(true);
                results.push(value);
            }
            Err(error) => match batch_operational_error(LABEL, error, committed_any) {
                PortError::Domain(domain)
                    if !matches!(domain, notarium_core::DomainError::RateLimited { .. }) =>
                {
                    results.push(json!({"index": index, "ok": false, "error": domain.code()}));
                }
                operational => return Err(operational),
            },
        }
    }
    Ok(json!({"results":results}))
}
