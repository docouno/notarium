use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    DomainError,
    auth::ResourceFacts,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{CommandKey, ContentDigest, NoteId, RevisionId},
    model::{FolderRef, HistoryScope, Lifecycle},
    ports::{CreateNote, LinkTarget, Mutation, Preconditions, SpaceContext},
    receipt::CommandIdentity,
    value::{Timestamp, YamlValue},
};
use notarium_syntax::{
    extract::finalize_document,
    frontmatter::{self, FieldEdit},
    markdown, patch,
    unicode::{lookup_key, validate_component},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::{command_actor, derive_digest, derive_key, organize};
use super::{
    EgressTarget, ToolCallContext, clean_path, decode, folder_base, generated_slug, invalid,
    receipt_result, relative_to, separator_after, session, validated_title,
};

pub(super) mod proposal;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    project: String,
    #[serde(flatten)]
    draft: NoteDraft,
    #[serde(default)]
    folder_page: bool,
    version_token: Option<RevisionId>,
}

#[derive(Deserialize)]
struct BatchInput {
    project: String,
    notes: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteDraft {
    body: String,
    title: Option<String>,
    path: Option<String>,
    #[serde(rename = "type")]
    note_type: Option<String>,
    tags: Option<Vec<String>>,
    #[serde(default)]
    links: Vec<organize::LinkArgs>,
    created_at: Option<Timestamp>,
    file_name: Option<String>,
    idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct CreateProject {
    pub(super) reference: FolderRef,
    pub(super) scope: HistoryScope,
}

struct CreatePlacement {
    project: CreateProject,
    read_scope: SpaceContext,
    write_scope: SpaceContext,
    path: String,
}

struct PreparedDraft {
    note: NoteId,
    command: CommandIdentity,
    title: String,
    slug: String,
    relative_path: String,
    folder_page: bool,
    carrier: String,
    draft: NoteDraft,
}

pub(super) async fn observe_project(
    call: &ToolCallContext<'_>,
    handle: &str,
) -> Result<CreateProject, PortError> {
    let project = session::resolve_project(call, handle).await?;
    let scope = session::space(call, &project.folder.space_id).await?;
    Ok(CreateProject {
        reference: project.folder,
        scope: scope.scope().clone(),
    })
}

async fn placement(call: &ToolCallContext<'_>, handle: &str) -> Result<CreatePlacement, PortError> {
    let project: CreateProject = call
        .journal("create_project", || observe_project(call, handle))
        .await?;
    project_placement(call, project).await
}

async fn project_placement(
    call: &ToolCallContext<'_>,
    project: CreateProject,
) -> Result<CreatePlacement, PortError> {
    if project.scope.space_id != project.reference.space_id {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    let read_scope = call.space(project.scope.clone())?;
    let write_scope = read_scope.clone().restrict_to_project(&project.reference)?;
    let live = call
        .registry
        .catalog
        .project(write_scope.clone(), project.reference.clone())
        .await?;
    if live.folder != project.reference {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let folder = call
        .registry
        .catalog
        .folder(call.account(), project.reference.clone())
        .await?;
    if folder.reference != project.reference
        || folder.space.id != project.scope.space_id
        || folder.lifecycle != Lifecycle::Active
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let facts = ResourceFacts {
        space: folder.space,
        class: DocClass::UserDoc,
        ancestor_folders: folder.ancestor_folders,
        folder_write_locked: folder.write_locked,
        ability_package: None,
    };
    write_scope.auth().authorize_direct_write(&facts, &facts)?;
    let live = folder_base(call, &write_scope, &project.reference.folder_id).await?;
    Ok(CreatePlacement {
        project,
        read_scope,
        write_scope,
        path: live.path,
    })
}

impl PreparedDraft {
    fn new(
        call: &ToolCallContext<'_>,
        placement: &CreatePlacement,
        draft: NoteDraft,
        folder_page: bool,
        position: u16,
        item_hash: Option<ContentDigest>,
    ) -> Result<Self, PortError> {
        if folder_page && draft.file_name.is_some() {
            return Err(invalid(ValidationReason::InvalidPathComponent));
        }
        let project = &placement.project;
        let command = item_command(call, project, &draft, position, item_hash);
        let note = stable_note_id(&command.key, &project.reference);
        let title = draft_title(&draft)?;
        let slug = if folder_page {
            "index".to_owned()
        } else {
            let slug = if let Some(raw) = &draft.file_name {
                let name = raw.trim();
                let name = name
                    .get(..name.len().saturating_sub(3))
                    .filter(|_| name.to_ascii_lowercase().ends_with(".md"))
                    .unwrap_or(name);
                validate_component(name)?;
                name.to_owned()
            } else {
                generated_slug(&title, &note)
            };
            if lookup_key(&slug) == "index" {
                return Err(invalid(ValidationReason::InvalidPathComponent));
            }
            slug
        };
        let path = clean_path(draft.path.as_deref().unwrap_or_default())?;
        let relative_path = relative_to(&path, &placement.path).unwrap_or(path);
        let plan = finalize_document(
            &draft.body,
            DocClass::UserDoc,
            &note,
            &fields(&draft, &title),
        )?;
        let carrier = patch::apply(&draft.body, &plan)?;
        Ok(Self {
            note,
            command,
            title,
            slug,
            relative_path,
            folder_page,
            carrier,
            draft,
        })
    }
}

fn item_command(
    call: &ToolCallContext<'_>,
    project: &CreateProject,
    draft: &NoteDraft,
    position: u16,
    item_hash: Option<ContentDigest>,
) -> CommandIdentity {
    let mut command = call.command_identity(&project.scope, "create_note", position);
    if let Some(hash) = item_hash {
        command.hash = hash;
        if matches!(call.target, EgressTarget::ExternalMcp)
            && let Some(key) = &draft.idempotency_key
        {
            command.key = derive_key(
                "notarium.mcp.create-note-item.v1",
                &[
                    command_actor(&call.auth).as_bytes(),
                    project.reference.space_id.as_str().as_bytes(),
                    project.reference.folder_id.as_str().as_bytes(),
                    key.as_bytes(),
                ],
            );
        }
    }
    command
}

fn stable_note_id(key: &CommandKey, project: &FolderRef) -> NoteId {
    let digest = derive_digest(
        "notarium.mcp.created-note.v1",
        &[
            project.space_id.as_str().as_bytes(),
            project.folder_id.as_str().as_bytes(),
            key.as_str().as_bytes(),
        ],
    );
    NoteId::from_bytes(digest.as_bytes()[..16].try_into().expect("fixed digest"))
}

fn draft_title(draft: &NoteDraft) -> Result<String, PortError> {
    if let Some(title) = &draft.title {
        return validated_title(title);
    }
    let header = frontmatter::analyze(&draft.body, DocClass::UserDoc)?;
    if let Some(YamlValue::String(title)) = header
        .fields
        .as_ref()
        .and_then(|fields| fields.get("title"))
    {
        return validated_title(title);
    }
    let analysis = markdown::analyze(&draft.body, header.carrier.body)?;
    if let Some(heading) = analysis.leading_h1(&draft.body, header.carrier.body) {
        return validated_title(&heading.title);
    }
    let first = header
        .carrier
        .body
        .slice(&draft.body)?
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?;
    validated_title(first)
}

fn fields(draft: &NoteDraft, title: &str) -> Vec<FieldEdit> {
    let mut edits = vec![FieldEdit::Set {
        key: "title".to_owned(),
        value: YamlValue::String(title.to_owned()),
    }];
    if let Some(note_type) = &draft.note_type {
        edits.push(FieldEdit::Set {
            key: "type".to_owned(),
            value: YamlValue::String(note_type.clone()),
        });
    }
    if let Some(tags) = &draft.tags {
        let mut seen = BTreeSet::new();
        let values = tags
            .iter()
            .filter_map(|tag| {
                let tag = tag.trim();
                (!tag.is_empty() && seen.insert(lookup_key(tag)))
                    .then(|| YamlValue::String(tag.to_owned()))
            })
            .collect();
        edits.push(FieldEdit::Set {
            key: "tags".to_owned(),
            value: YamlValue::Sequence(values),
        });
    }
    if let Some(created_at) = &draft.created_at {
        edits.push(FieldEdit::Set {
            key: "created".to_owned(),
            value: YamlValue::String(String::from(*created_at)),
        });
    }
    edits
}

async fn prepare_carrier(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    draft: &PreparedDraft,
    titles: &BTreeMap<String, BTreeSet<NoteId>>,
) -> Result<String, PortError> {
    let mut lines = String::new();
    for link in &draft.draft.links {
        let (target, _) =
            organize::resolve_target(call, scope, link.to.as_deref(), link.to_title.as_deref())
                .await?;
        let (target, label) = match &target {
            LinkTarget::AuthoredName(title) => match titles.get(&lookup_key(title)) {
                Some(ids) if ids.len() == 1 => (
                    LinkTarget::Note(ids.first().expect("one batch target").clone()),
                    Some(title.as_str()),
                ),
                _ => (target.clone(), None),
            },
            _ => (target.clone(), None),
        };
        lines.push_str(&organize::format_link_line(&link.relation, &target, label)?);
    }
    let carrier = &draft.carrier;
    if lines.is_empty() {
        return Ok(carrier.clone());
    }
    let header = notarium_syntax::carrier::Carrier::scan(carrier)?;
    let analysis = markdown::analyze(carrier, header.body)?;
    // Put graph links after the leading heading, before an open fence could
    // swallow them. Insert bytes without rewriting any authored paragraph.
    let at = analysis
        .leading_h1(carrier, header.body)
        .map_or(header.body.start(), |heading| heading.heading_span.end());
    let (before, after) = carrier.split_at(at);
    let eol = header.eol;
    let separator =
        if header.header.is_some() && at == header.body.start() && !before.ends_with('\n') {
            eol
        } else {
            separator_after(&before[header.body.start()..], eol)
        };
    let lines = if eol == "\r\n" {
        lines.replace('\n', eol)
    } else {
        lines
    };
    Ok(format!("{before}{separator}{lines}{eol}{after}"))
}

async fn execute(
    call: &mut ToolCallContext<'_>,
    placement: &CreatePlacement,
    prepared: PreparedDraft,
    carrier: String,
) -> Result<Value, PortError> {
    let scope = placement.write_scope.clone();
    let parent = super::ensure_destination(
        call,
        &scope,
        Some(placement.project.reference.folder_id.clone()),
        prepared.relative_path,
        &prepared.command,
        "create_destination",
        None,
    )
    .await?;
    let note = prepared.note.clone();
    let write = Mutation {
        identity: prepared.command,
        preconditions: Preconditions::default(),
        input: CreateNote {
            note: prepared.note,
            parent: Some(parent.folder_id.clone()),
            slug: prepared.slug,
            class: DocClass::UserDoc,
            carrier,
            folder_page: prepared.folder_page,
        },
    };
    let committed = call
        .registry
        .engine
        .create_note(scope.clone(), write)
        .await?;
    let mut result = receipt_result(call, scope, &note, committed, "created").await?;
    if result.get("noteId").is_some() {
        result["bodyBytes"] = json!(prepared.draft.body.len());
        result["bodyHash"] = json!(notarium_syntax::content_digest(&prepared.draft.body));
        if prepared.folder_page && matches!(call.target, EgressTarget::ExternalMcp) {
            result["folderPage"] =
                json!({ "status": "present", "folderId": parent.folder_id, "noteId": note });
        }
    }
    Ok(result)
}

pub(super) async fn create_one(
    call: &mut ToolCallContext<'_>,
    raw: Value,
) -> Result<Value, PortError> {
    let input: CreateInput = decode(raw)?;
    if input.version_token.is_some() {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    let placement = placement(call, &input.project).await?;
    let prepared = PreparedDraft::new(call, &placement, input.draft, input.folder_page, 0, None)?;
    let carrier = prepare_carrier(call, &placement.read_scope, &prepared, &BTreeMap::new()).await?;
    execute(call, &placement, prepared, carrier).await
}

pub(super) async fn create_many(
    call: &mut ToolCallContext<'_>,
    raw: Value,
) -> Result<Value, PortError> {
    let input: BatchInput = decode(raw)?;
    let placement = placement(call, &input.project).await?;
    let mut titles: BTreeMap<String, BTreeSet<NoteId>> = BTreeMap::new();
    let prepared = input
        .notes
        .into_iter()
        .enumerate()
        .map(|(index, raw)| {
            let bytes =
                serde_json::to_vec(&raw).map_err(|_| invalid(ValidationReason::InvalidQuery))?;
            let hash = derive_digest("notarium.mcp.create-note-item-arguments.v1", &[&bytes]);
            let draft: NoteDraft = decode(raw)?;
            let item =
                PreparedDraft::new(call, &placement, draft, false, index as u16, Some(hash))?;
            titles
                .entry(lookup_key(&item.title))
                .or_default()
                .insert(item.note.clone());
            Ok(item)
        })
        .collect::<Vec<Result<PreparedDraft, PortError>>>();
    let mut results = Vec::with_capacity(prepared.len());
    for (index, prepared) in prepared.into_iter().enumerate() {
        let result = async {
            let prepared = prepared?;
            let carrier = prepare_carrier(call, &placement.read_scope, &prepared, &titles).await?;
            execute(call, &placement, prepared, carrier).await
        }
        .await;
        results.push(match result {
            Ok(mut value) => {
                value["index"] = json!(index);
                value["ok"] = json!(true);
                value
            }
            Err(error) => json!({ "index": index, "ok": false, "error": error.code() }),
        });
    }
    Ok(json!({ "results": results }))
}
