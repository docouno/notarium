use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, NoteId},
    model::HistoryScope,
    ports::{CreateNote, Mutation, Preconditions},
};
use notarium_syntax::unicode::lookup_key;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    BatchInput, CreateInput, CreateProject, PreparedDraft, ToolCallContext, decode, invalid,
    observe_project, prepare_carrier, project_placement, receipt_result,
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
    Ready(ProposedDraft),
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
    let placement = project_placement(reviewer, plan.project.clone()).await?;
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

pub(in crate::mcp::note_tools) async fn prepare(
    owner: &ToolCallContext<'_>,
    tool: ToolName,
    args: Value,
) -> Result<ProposedCreates, PortError> {
    let (project, drafts, batch, folder_page) = match tool {
        ToolName::CreateNote => {
            let input: CreateInput = decode(args)?;
            if input.version_token.is_some() {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
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
    let place = project_placement(owner, project).await?;
    let mut titles: BTreeMap<String, BTreeSet<NoteId>> = BTreeMap::new();
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
            titles
                .entry(lookup_key(&draft.title))
                .or_default()
                .insert(draft.note.clone());
            Ok::<_, PortError>((draft, destination))
        }
        .await;
        draft_plans.push(plan);
    }
    let mut steps = Vec::with_capacity(draft_plans.len());
    for plan in draft_plans {
        let proposed = async {
            let (draft, destination) = plan?;
            let carrier = prepare_carrier(owner, &place.read_scope, &draft, &titles).await?;
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
            Ok(draft) => CreateStep::Ready(draft),
            Err(error) if batch => CreateStep::Invalid {
                code: error.code().to_owned(),
            },
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
) -> Result<Value, PortError> {
    let (folder_ctx, folder_identity) = step(&project.scope, "create_destination", index)?;
    let folder_scope = folder_ctx.restrict_to_project(&project.reference)?;
    let parent = draft
        .destination
        .apply(
            owner,
            folder_scope,
            folder_identity,
            DocClass::UserDoc,
            None,
        )
        .await?;
    let (write_ctx, identity) = step(&project.scope, "create_note", index)?;
    let scope = write_ctx.restrict_to_project(&project.reference)?;
    let committed = owner
        .registry
        .engine
        .create_note(
            scope.clone(),
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
        .await?;
    let mut result = receipt_result(owner, scope, &draft.note, committed, "created").await?;
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
        return apply_one(owner, &plan.project, draft, step, 0).await;
    }
    let mut results = Vec::with_capacity(plan.steps.len());
    for (index, row) in plan.steps.into_iter().enumerate() {
        let result = match row {
            CreateStep::Ready(draft) => {
                apply_one(owner, &plan.project, draft, step, index as u16).await
            }
            CreateStep::Invalid { code } => {
                results.push(json!({"index":index, "ok":false, "error":code}));
                continue;
            }
        };
        results.push(match result {
            Ok(mut value) => {
                value["index"] = json!(index);
                value["ok"] = json!(true);
                value
            }
            Err(error) => json!({"index": index, "ok": false, "error":error.code()}),
        });
    }
    Ok(json!({"results":results}))
}
