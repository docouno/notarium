use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    DomainError,
    auth::ResourceFacts,
    classes::DocClass,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{CommandKey, ContentDigest, FolderId, NoteId},
    model::{FolderRef, HistoryScope, Lifecycle},
    patch::CarrierEditOrigin,
    ports::{
        Committed, CreateNote, EditNote, LinkTarget, Mutation, NoteRevision, Preconditions,
        SpaceContext,
    },
    receipt::CommandIdentity,
    span::ByteSpan,
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

use super::super::{command_actor, corpus, derive_digest, derive_key, organize};
use super::{
    EgressTarget, ToolCallContext, clean_path, decode, folder_base, generated_slug, invalid,
    receipt_result, separator_after, session, validated_title,
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
    // Accepted for legacy callers. A create always requires an unused destination.
    #[serde(rename = "versionToken")]
    _version_token: Option<String>,
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
    corpus::admit_folder_write(
        call,
        &read_scope,
        &project.reference,
        Some(project.reference.clone()),
        &folder.ancestor_folders,
        DocClass::UserDoc,
    )
    .await?;
    let facts = ResourceFacts {
        space: folder.space,
        class: DocClass::UserDoc,
        project: Some(project.reference.folder_id.clone()),
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
        let relative_path = corpus::strip_folder_prefix(&path, &placement.path).unwrap_or(path);
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

struct PreparedLink {
    relation: String,
    target: LinkTarget,
}

async fn prepare_links(
    call: &ToolCallContext<'_>,
    provider: Option<&ToolCallContext<'_>>,
    scope: &SpaceContext,
    draft: &PreparedDraft,
) -> Result<Vec<PreparedLink>, PortError> {
    let mut links = Vec::with_capacity(draft.draft.links.len());
    for link in &draft.draft.links {
        let (target, _) = organize::resolve_target(
            call,
            provider,
            scope,
            link.to.as_deref(),
            link.to_title.as_deref(),
        )
        .await?;
        links.push(PreparedLink {
            relation: link.relation.clone(),
            target,
        });
    }
    Ok(links)
}

fn link_lines(
    links: &[PreparedLink],
    bindings: &BTreeMap<usize, NoteId>,
) -> Result<String, PortError> {
    let mut lines = String::new();
    for (index, PreparedLink { relation, target }) in links.iter().enumerate() {
        if let LinkTarget::AuthoredName(title) = target
            && let Some(note) = bindings.get(&index)
        {
            lines.push_str(&organize::format_link_line(
                relation,
                &LinkTarget::Note(note.clone()),
                Some(title),
            )?);
        } else {
            lines.push_str(&organize::format_link_line(relation, target, None)?);
        }
    }
    Ok(lines)
}

fn carrier_with_links(
    carrier: &str,
    lines: String,
) -> Result<(String, Option<ByteSpan>), PortError> {
    if lines.is_empty() {
        return Ok((carrier.to_owned(), None));
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
    let start = at + separator.len();
    let block = ByteSpan::new(start, start + lines.len())?;
    Ok((
        format!("{before}{separator}{lines}{eol}{after}"),
        Some(block),
    ))
}

async fn prepare_carrier(
    call: &ToolCallContext<'_>,
    provider: Option<&ToolCallContext<'_>>,
    scope: &SpaceContext,
    draft: &PreparedDraft,
) -> Result<String, PortError> {
    let links = prepare_links(call, provider, scope, draft).await?;
    let (carrier, _) = carrier_with_links(&draft.carrier, link_lines(&links, &BTreeMap::new())?)?;
    Ok(carrier)
}

async fn execute(
    call: &ToolCallContext<'_>,
    placement: &CreatePlacement,
    prepared: &PreparedDraft,
    carrier: String,
    committed_any: &mut bool,
) -> Result<(Committed<NoteRevision>, FolderId), PortError> {
    const LABEL: &str = "notarium.mcp.create-note.v1";
    let scope = placement.write_scope.clone();
    let (parent, created_folder) = super::ensure_destination(
        call,
        &scope,
        Some(placement.project.reference.folder_id.clone()),
        prepared.relative_path.clone(),
        DocClass::UserDoc,
        &prepared.command,
        "create_destination",
        None,
    )
    .await?;
    if created_folder {
        *committed_any = true;
    }
    let write = Mutation {
        identity: prepared.command.clone(),
        preconditions: Preconditions::default(),
        input: CreateNote {
            note: prepared.note.clone(),
            parent: Some(parent.folder_id.clone()),
            slug: prepared.slug.clone(),
            class: DocClass::UserDoc,
            carrier,
            folder_page: prepared.folder_page,
        },
    };
    let writer = call
        .corpus_writer(scope)
        .await
        .map_err(|error| batch_operational_error(LABEL, error, *committed_any))?;
    let committed = call
        .registry
        .engine
        .create_note(writer, write)
        .await
        .map_err(|error| match error {
            PortError::Domain(domain) => PortError::Domain(domain),
            operational => batch_operational_error(LABEL, operational, *committed_any),
        })?;
    *committed_any = true;
    Ok((committed, parent.folder_id))
}

async fn result(
    call: &mut ToolCallContext<'_>,
    placement: &CreatePlacement,
    prepared: &PreparedDraft,
    committed: Committed<NoteRevision>,
    parent: FolderId,
) -> Result<Value, PortError> {
    let note = &prepared.note;
    let mut result = receipt_result(
        call,
        placement.write_scope.clone(),
        note,
        committed,
        "created",
    )
    .await?;
    if result.get("noteId").is_some() {
        result["bodyBytes"] = json!(prepared.draft.body.len());
        result["bodyHash"] = json!(notarium_syntax::content_digest(&prepared.draft.body));
        if prepared.folder_page && matches!(call.target, EgressTarget::ExternalMcp) {
            result["folderPage"] =
                json!({ "status": "present", "folderId": parent, "noteId": note });
        }
    }
    Ok(result)
}

pub(super) async fn create_one(
    call: &mut ToolCallContext<'_>,
    raw: Value,
) -> Result<Value, PortError> {
    let input: CreateInput = decode(raw)?;
    let placement = placement(call, &input.project).await?;
    let prepared = PreparedDraft::new(call, &placement, input.draft, input.folder_page, 0, None)?;
    let carrier = prepare_carrier(call, None, &placement.read_scope, &prepared).await?;
    let mut committed_any = false;
    let (committed, parent) =
        execute(call, &placement, &prepared, carrier, &mut committed_any).await?;
    result(call, &placement, &prepared, committed, parent)
        .await
        .map_err(|error| batch_operational_error("notarium.mcp.create-note.v1", error, true))
}

struct CreatedDraft {
    prepared: PreparedDraft,
    carrier: String,
    links: Vec<PreparedLink>,
    link_block: Option<ByteSpan>,
    committed: Committed<NoteRevision>,
    parent: FolderId,
}

async fn create_draft(
    call: &ToolCallContext<'_>,
    placement: &CreatePlacement,
    index: u16,
    raw: Value,
    committed_any: &mut bool,
) -> Result<CreatedDraft, PortError> {
    let bytes = serde_json::to_vec(&raw).map_err(|_| invalid(ValidationReason::InvalidQuery))?;
    let hash = derive_digest("notarium.mcp.create-note-item-arguments.v1", &[&bytes]);
    let prepared = PreparedDraft::new(call, placement, decode(raw)?, false, index, Some(hash))?;
    let links = prepare_links(call, None, &placement.read_scope, &prepared).await?;
    let (carrier, link_block) =
        carrier_with_links(&prepared.carrier, link_lines(&links, &BTreeMap::new())?)?;
    let (committed, parent) =
        execute(call, placement, &prepared, carrier.clone(), committed_any).await?;
    let post_commit_integrity = |reason: &str| {
        PortError::Unavailable(
            OperationalFailure::new(
                derive_digest("notarium.mcp.create-notes-batch.v1", &[reason.as_bytes()]),
                CommitEffect::Unknown,
                RetryAdvice::RetrySameCommand,
                true,
            )
            .expect("same-command retry has durable identity"),
        )
    };
    placement
        .write_scope
        .scope()
        .check(committed.receipt.scope())
        .map_err(|_| post_commit_integrity("receipt_scope_mismatch"))?;
    if committed.value.note != prepared.note {
        return Err(post_commit_integrity("receipt_note_mismatch"));
    }
    Ok(CreatedDraft {
        prepared,
        carrier,
        links,
        link_block,
        committed,
        parent,
    })
}

async fn resolve_batch_links(
    call: &ToolCallContext<'_>,
    placement: &CreatePlacement,
    draft: &CreatedDraft,
    titles: &BTreeMap<String, BTreeSet<NoteId>>,
) -> Result<Option<Committed<NoteRevision>>, PortError> {
    let Some(block) = draft.link_block else {
        return Ok(None);
    };
    if !draft
        .links
        .iter()
        .any(|link| matches!(link.target, LinkTarget::AuthoredName(_)))
    {
        return Ok(None);
    }
    // Neighboring creates may succeed on retry. Fix this item's choices,
    // including an empty selection, before applying its revision-guarded edit.
    let command = &draft.prepared.command;
    let bindings = call
        .journal_with_key(
            "create_link_bindings",
            &command.key,
            command.hash,
            || async {
                Ok(draft
                    .links
                    .iter()
                    .enumerate()
                    .filter_map(|(index, link)| {
                        let LinkTarget::AuthoredName(title) = &link.target else {
                            return None;
                        };
                        let ids = titles.get(&lookup_key(title))?;
                        match ids.first() {
                            Some(note) if ids.len() == 1 => Some((index, note.clone())),
                            _ => None,
                        }
                    })
                    .collect::<BTreeMap<_, _>>())
            },
        )
        .await?;
    let header = notarium_syntax::carrier::Carrier::scan(&draft.carrier)?;
    let resolved = link_lines(&draft.links, &bindings)?;
    let resolved = if header.eol == "\r\n" {
        resolved.replace('\n', header.eol)
    } else {
        resolved
    };
    if resolved == block.slice(&draft.carrier)? {
        return Ok(None);
    }
    let mut identity = command.clone();
    identity.key = derive_key(
        "notarium.mcp.create-note-link-resolution.v1",
        &[
            identity.key.as_str().as_bytes(),
            notarium_syntax::content_digest(&resolved).as_bytes(),
        ],
    );
    let plan = patch::plan(
        &draft.carrier,
        header.body,
        vec![(CarrierEditOrigin::Body, block, resolved)],
    )?;
    let scope = call
        .space(placement.project.scope.clone())?
        .restrict_to_project(&placement.project.reference)?;
    call.registry
        .engine
        .edit_note(
            call.corpus_writer(scope).await?,
            Mutation {
                identity,
                preconditions: Preconditions {
                    revision: Some(draft.committed.value.revision.clone()),
                    ..Preconditions::default()
                },
                input: EditNote {
                    note: draft.prepared.note.clone(),
                    plan,
                },
            },
        )
        .await
        .map(Some)
}

pub(in crate::mcp) fn post_commit_error(label: &str, error: PortError) -> PortError {
    match batch_operational_error(label, error, true) {
        PortError::Domain(domain) => PortError::Unavailable(
            OperationalFailure::new(
                derive_digest(label, &[domain.code().as_bytes()]),
                CommitEffect::Unknown,
                RetryAdvice::RetrySameCommand,
                true,
            )
            .expect("same-command retry has durable identity"),
        ),
        other => other,
    }
}

pub(in crate::mcp) fn batch_operational_error(
    label: &str,
    error: PortError,
    committed_any: bool,
) -> PortError {
    if matches!(error, PortError::Domain(_)) {
        return error;
    }
    let unknown_retryable = matches!(
        &error,
        PortError::Cancelled(failure)
            | PortError::DeadlineExceeded(failure)
            | PortError::Unavailable(failure)
            | PortError::Internal(failure)
            if failure.effect() == CommitEffect::Unknown
                && failure.retry() == RetryAdvice::RetrySameCommand
    );
    if unknown_retryable {
        return error;
    }
    let unknown_any = matches!(
        &error,
        PortError::Cancelled(failure)
            | PortError::DeadlineExceeded(failure)
            | PortError::Unavailable(failure)
            | PortError::Internal(failure)
            if failure.effect() == CommitEffect::Unknown
    );
    if unknown_any || committed_any {
        let diagnostic = derive_digest(label, &[error.code().as_bytes()]);
        let failure = OperationalFailure::new(
            diagnostic,
            CommitEffect::Unknown,
            RetryAdvice::RetrySameCommand,
            true,
        )
        .expect("same-command retry has durable identity");
        match error {
            PortError::Cancelled(_) => PortError::Cancelled(failure),
            PortError::DeadlineExceeded(_) => PortError::DeadlineExceeded(failure),
            PortError::Unavailable(_) | PortError::Internal(_) => PortError::Unavailable(failure),
            PortError::Domain(domain) => PortError::Domain(domain),
        }
    } else {
        error
    }
}

pub(super) async fn create_many(
    call: &mut ToolCallContext<'_>,
    raw: Value,
) -> Result<Value, PortError> {
    const LABEL: &str = "notarium.mcp.create-notes-batch.v1";
    let input: BatchInput = decode(raw)?;
    let placement = placement(call, &input.project).await?;
    let mut titles: BTreeMap<String, BTreeSet<NoteId>> = BTreeMap::new();
    let mut created = Vec::with_capacity(input.notes.len());
    let mut committed_any = false;
    // Commit independently before treating any generated ID as a valid target.
    for (index, raw) in input.notes.into_iter().enumerate() {
        match create_draft(call, &placement, index as u16, raw, &mut committed_any).await {
            Ok(item) => {
                committed_any = true;
                titles
                    .entry(lookup_key(&item.prepared.title))
                    .or_default()
                    .insert(item.prepared.note.clone());
                created.push(Ok(item));
            }
            Err(PortError::Domain(error)) => created.push(Err(error)),
            Err(error) => return Err(batch_operational_error(LABEL, error, committed_any)),
        }
    }
    let mut results = Vec::with_capacity(created.len());
    for (index, row) in created.into_iter().enumerate() {
        let draft = match row {
            Ok(draft) => draft,
            Err(error) => {
                results.push(json!({ "index": index, "ok": false, "error": error.code() }));
                continue;
            }
        };
        let (committed, link_error) =
            match resolve_batch_links(call, &placement, &draft, &titles).await {
                Ok(Some(committed)) => (committed, None),
                Ok(None) => (draft.committed, None),
                Err(error) => (draft.committed, Some(error.code())),
            };
        let mut value = result(call, &placement, &draft.prepared, committed, draft.parent)
            .await
            .map_err(|error| batch_operational_error(LABEL, error, true))?;
        if let Some(error) = link_error {
            value["linkError"] = json!(error);
        }
        value["index"] = json!(index);
        value["ok"] = json!(true);
        results.push(value);
    }
    Ok(json!({ "results": results }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(effect: CommitEffect, retry: RetryAdvice, idempotent: bool) -> OperationalFailure {
        OperationalFailure::new(
            ContentDigest::from_bytes([1; 32]),
            effect,
            retry,
            idempotent,
        )
        .unwrap()
    }

    #[test]
    fn batch_operational_error_preserves_variants_and_unknown_retry_advice() {
        let label = "notarium.test.batch-op.v1";

        let uncomm =
            PortError::Unavailable(op(CommitEffect::NotCommitted, RetryAdvice::Never, false));
        assert_eq!(
            batch_operational_error(label, uncomm.clone(), false),
            uncomm
        );

        let upgraded_unavail = batch_operational_error(label, uncomm, true);
        assert!(matches!(
            upgraded_unavail,
            PortError::Unavailable(f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ));

        let cancelled =
            PortError::Cancelled(op(CommitEffect::NotCommitted, RetryAdvice::Never, false));
        let upgraded_cancel = batch_operational_error(label, cancelled, true);
        assert!(matches!(
            upgraded_cancel,
            PortError::Cancelled(f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ));

        let deadline =
            PortError::DeadlineExceeded(op(CommitEffect::NotCommitted, RetryAdvice::Never, false));
        let upgraded_deadline = batch_operational_error(label, deadline, true);
        assert!(matches!(
            upgraded_deadline,
            PortError::DeadlineExceeded(f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ));

        let unknown_never =
            PortError::DeadlineExceeded(op(CommitEffect::Unknown, RetryAdvice::Never, false));
        let upgraded_unknown = batch_operational_error(label, unknown_never, false);
        assert!(matches!(
            upgraded_unknown,
            PortError::DeadlineExceeded(f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ));

        let domain = PortError::Domain(DomainError::ResourceNotFound);
        assert_eq!(batch_operational_error(label, domain.clone(), true), domain);

        let rate_limited = PortError::Domain(DomainError::RateLimited {
            retry_after_ms: 1000,
            budget: notarium_core::error::BudgetKind::Concurrency,
        });
        assert!(matches!(
            post_commit_error(label, rate_limited),
            PortError::Unavailable(f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ));
        assert!(matches!(
            post_commit_error(label, invalid(ValidationReason::SourceMismatch)),
            PortError::Unavailable(f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ));
    }
}
