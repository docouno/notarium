use super::{EgressTarget, ToolCallContext, invalid, session};
use notarium_core::{
    DomainError,
    classes::{
        ClassEgressFence, ClassifiedDocument, ClassifiedMetadata, DocClass, ProviderCurrentContent,
        ProviderOrigin, SearchPart, authorize_field_key,
    },
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, SpaceId},
    model::{FolderRef, Lifecycle, NoteRef},
    ports::{
        CatalogDisclosure, CatalogNote, FolderSnapshot, NoteSnapshot, ProviderErrorCode,
        ProviderSelection, SpaceContext,
    },
};
use serde_json::Value;
use std::{collections::BTreeMap, ops::Range, sync::Mutex};

async fn catalog_note(
    call: &ToolCallContext<'_>,
    space: &SpaceId,
    id: &NoteId,
) -> Result<CatalogNote, PortError> {
    if call
        .auth
        .spaces()
        .get(space)
        .is_none_or(|grant| grant.read_classes.is_empty())
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let reference = NoteRef {
        space_id: space.clone(),
        note_id: id.clone(),
    };
    let note = call
        .registry
        .catalog
        .note(call.account(), reference.clone())
        .await?;
    if note.reference != reference || note.facts.space.id != *space {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if note.lifecycle != Lifecycle::Active || note.facts.class == DocClass::EncryptedNote {
        return Err(DomainError::ResourceNotFound.into());
    }
    call.auth.can_view_resource(&note.facts)?;
    Ok(note)
}

pub(super) async fn note_in_space(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    id: &NoteId,
) -> Result<CatalogNote, PortError> {
    let note = catalog_note(call, &scope.scope().space_id, id).await?;
    scope.auth().authorize_read(&note.facts)?;
    Ok(note)
}

pub(super) async fn locate_note(
    call: &ToolCallContext<'_>,
    id: &NoteId,
) -> Result<(SpaceContext, CatalogNote), PortError> {
    let mut found = None;
    for space in call.auth.spaces().keys() {
        match catalog_note(call, space, id).await {
            Ok(note) if found.is_none() => found = Some(note),
            Ok(_) => return Err(DomainError::ResourceNotFound.into()),
            Err(error) if hidden(&error) => (),
            Err(error) => return Err(error),
        }
    }
    let note = found.ok_or(DomainError::ResourceNotFound)?;
    let scope = session::space(call, &note.reference.space_id).await?;
    scope.auth().authorize_read(&note.facts)?;
    Ok((scope, note))
}

/// Reuse project consent only while ranking candidates within one Space.
#[derive(Default)]
pub(super) struct CandidatePolicies(Mutex<BTreeMap<Option<FolderId>, Option<ProviderSelection>>>);

async fn select_source(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    project: Option<FolderRef>,
    candidates: Option<&CandidatePolicies>,
) -> Result<Option<ProviderSelection>, PortError> {
    let Some(cache) = candidates else {
        return call.provider_selection(scope, project).await;
    };
    let key = project.as_ref().map(|project| project.folder_id.clone());
    if let Some(hit) = cache
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .get(&key)
        .cloned()
    {
        return hit
            .map(Some)
            .ok_or_else(|| DomainError::ResourceNotFound.into());
    }
    let result = call.provider_selection(scope, project).await;
    let entry = match &result {
        Ok(Some(selection)) => Some(selection.clone()),
        Err(error) if hidden(error) => None,
        _ => return result,
    };
    let mut policies = cache.0.lock().unwrap_or_else(|err| err.into_inner());
    if policies.len() >= 200 {
        policies.clear();
    }
    policies.insert(key, entry);
    result
}

async fn source_policy(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    project: Option<FolderRef>,
    candidates: Option<&CandidatePolicies>,
    in_project: impl Fn(&FolderRef) -> bool,
) -> Result<Option<ProviderSelection>, PortError> {
    let Some(mut selection) = select_source(call, scope, project.clone(), candidates).await? else {
        return Ok(None);
    };
    if let EgressTarget::InAppProvider {
        primary_project: Some(primary),
        ..
    } = &call.target
        && primary.space_id == scope.scope().space_id
        && Some(primary) != project.as_ref()
    {
        let admission = select_source(call, scope, Some(primary.clone()), candidates)
            .await?
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        selection
            .policy
            .allowed_classes
            .retain(|class| admission.policy.allowed_classes.contains(class));
        if let Some(boundary) = admission.project_only {
            if !in_project(&boundary) {
                return Err(DomainError::ResourceNotFound.into());
            }
            selection.project_only.get_or_insert(boundary);
        }
    }
    if selection
        .project_only
        .as_ref()
        .is_some_and(|project| !in_project(project))
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(Some(selection))
}

async fn note_policy(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    reference: &NoteRef,
    in_project: impl Fn(&FolderRef) -> bool,
) -> Result<Option<ProviderSelection>, PortError> {
    if reference.space_id != scope.scope().space_id {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let current = note_in_space(call, scope, &reference.note_id).await?;
    if matches!(call.target, EgressTarget::ExternalMcp) {
        return Ok(None);
    }
    let project = current.facts.project.clone().map(|folder_id| FolderRef {
        space_id: scope.scope().space_id.clone(),
        folder_id,
    });
    let admitted = source_policy(call, scope, project, None, |project| {
        current.facts.ancestor_folders.contains(&project.folder_id) && in_project(project)
    })
    .await?;
    if admitted
        .as_ref()
        .is_some_and(|rule| !rule.policy.allowed_classes.contains(&current.facts.class))
    {
        return Err(invalid(ValidationReason::ClassEgressForbidden));
    }
    Ok(admitted)
}

pub(super) async fn admit_search_card(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    card: &ClassifiedMetadata,
    candidates: &CandidatePolicies,
) -> Result<(), PortError> {
    if card.reference().space_id != scope.scope().space_id {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    // Hydration already bound current facts. Disclosure rechecks the source at delivery.
    if let Some(selection) = source_policy(
        call,
        scope,
        card.current_project(),
        Some(candidates),
        |project| card.in_project(project),
    )
    .await?
    {
        ClassEgressFence::provider_note_metadata(card, scope.auth(), &selection.policy)?;
    }
    Ok(())
}

async fn admit_metadata(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    metadata: &ClassifiedMetadata,
) -> Result<(ProviderOrigin, Option<FolderRef>), PortError> {
    if let Some(selection) = note_policy(call, scope, metadata.reference(), |project| {
        metadata.in_project(project)
    })
    .await?
    {
        let origin =
            ClassEgressFence::provider_note_metadata(metadata, scope.auth(), &selection.policy)?;
        Ok((origin, selection.project_only))
    } else {
        Ok((
            ClassEgressFence::mcp_note_metadata(metadata, scope.auth())?,
            None,
        ))
    }
}

pub(super) async fn note_metadata_origin(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    note: &NoteSnapshot,
) -> Result<(ProviderOrigin, Option<FolderRef>), PortError> {
    admit_metadata(call, scope, &note.document.metadata()).await
}

pub(super) async fn note_metadata(
    call: &mut ToolCallContext<'_>,
    scope: &SpaceContext,
    metadata: &ClassifiedMetadata,
) -> Result<(), PortError> {
    let (origin, project) = admit_metadata(call, scope, metadata).await?;
    call.record_origin(origin, project)
}

pub(super) async fn note_document(
    call: &mut ToolCallContext<'_>,
    scope: &SpaceContext,
    document: &ClassifiedDocument,
) -> Result<String, PortError> {
    if let Some(selection) = note_policy(call, scope, document.reference(), |project| {
        document.in_project(project)
    })
    .await?
    {
        let content =
            ClassEgressFence::provider(document.clone(), scope.auth(), &selection.policy)?;
        call.record_origin(document.origin(), selection.project_only)?;
        Ok(content.text().to_owned())
    } else {
        Ok(ClassEgressFence::mcp_note(document, scope.auth())?.to_owned())
    }
}

pub(super) async fn search_part(
    call: &mut ToolCallContext<'_>,
    scope: &SpaceContext,
    card: &ClassifiedMetadata,
    part: &SearchPart,
) -> Result<String, PortError> {
    let document = part.provenance();
    if let Some(selection) = note_policy(call, scope, document.reference(), |project| {
        card.in_project(project) && part.in_project(project)
    })
    .await?
    {
        let origin =
            ClassEgressFence::provider_note_metadata(card, scope.auth(), &selection.policy)?;
        let content =
            ClassEgressFence::provider_part(part.part().clone(), scope.auth(), &selection.policy)?;
        call.record_origin(origin, selection.project_only.clone())?;
        call.record_origin(document.origin(), selection.project_only)?;
        Ok(content.text().to_owned())
    } else {
        ClassEgressFence::mcp_note_metadata(card, scope.auth())?;
        Ok(
            ClassEgressFence::search_part(part.part().clone(), scope.auth())?
                .text()
                .to_owned(),
        )
    }
}

pub(super) async fn folder_metadata(
    call: &mut ToolCallContext<'_>,
    scope: &SpaceContext,
    folder: &FolderSnapshot,
) -> Result<Value, PortError> {
    scope.scope().check(&folder.history)?;
    let proof = call
        .registry
        .catalog
        .disclosure(
            call.account(),
            CatalogDisclosure::Folder(folder.reference.clone()),
        )
        .await?;
    if !matches!(proof.current(), ProviderCurrentContent::Folder { reference, history, revision, .. }
        if reference == &folder.reference && history == scope.scope() && revision == &folder.revision)
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let project = folder.project.clone().map(|folder_id| FolderRef {
        space_id: scope.scope().space_id.clone(),
        folder_id,
    });
    if let Some(selection) = source_policy(call, scope, project, None, |project| {
        proof.current().in_project(project)
    })
    .await?
    {
        ClassEgressFence::provider_metadata(proof.clone(), scope.auth(), &selection.policy)?;
        call.record_origin(proof.current().origin(), selection.project_only)?;
    }
    let text = ClassEgressFence::mcp_metadata(&proof, scope.auth())?;
    serde_json::from_str(text).map_err(|_| invalid(ValidationReason::InvalidState))
}

pub(super) fn hidden(error: &PortError) -> bool {
    match error {
        PortError::Domain(
            DomainError::ResourceNotFound | DomainError::AccessDenied | DomainError::SpaceReadOnly,
        ) => true,
        PortError::Domain(DomainError::Provider {
            error: ProviderErrorCode::Unavailable,
        }) => true,
        PortError::Domain(DomainError::ValidationFailed { diagnostic }) => matches!(
            diagnostic.reason,
            ValidationReason::ClassEgressForbidden | ValidationReason::ProviderConsentRequired
        ),
        _ => false,
    }
}

pub(super) fn validate_field_key(key: &str) -> Result<(), PortError> {
    authorize_field_key(key)?;
    if control_tags(key).next().is_some() {
        return Err(invalid(ValidationReason::ProtectedField));
    }
    Ok(())
}

fn control_tags(text: &str) -> impl Iterator<Item = Range<usize>> {
    const TAGS: &[&str] = &[
        "system",
        "systemprompt",
        "instruction",
        "instructions",
        "assistant",
        "developer",
        "human",
        "user",
        "tool_call",
        "tool_result",
        "tool_use",
        "function_call",
        "function_calls",
        "function_result",
        "function_results",
        "antml",
    ];
    let end = text.rfind('>').map_or(0, |index| index + 1);
    let mut covered = 0;
    text[..end]
        .match_indices('<')
        .filter_map(move |(start, _)| {
            if start < covered {
                return None;
            }
            let after = &text[start + 1..];
            let tag = after.strip_prefix('/').unwrap_or(after);
            let name_end = tag.find(|c: char| !c.is_ascii_alphanumeric() && c != '_')?;
            let name = &tag[..name_end];
            if TAGS
                .iter()
                .any(|control| control.eq_ignore_ascii_case(name))
            {
                covered = start + after.find('>')? + 2;
                Some(start..covered)
            } else {
                None
            }
        })
}

fn sanitize_text(text: &str) -> Option<String> {
    let mut end = 0;
    let mut escaped = String::new();
    for tag in control_tags(text) {
        escaped.push_str(&text[end..tag.start]);
        escaped.push('‹');
        escaped.push_str(&text[tag.start + 1..tag.end - 1]);
        escaped.push('›');
        end = tag.end;
    }
    if end == 0 {
        return None;
    }
    escaped.push_str(&text[end..]);
    Some(escaped)
}

pub(super) fn sanitize_display(display: &mut Value) {
    match display {
        Value::String(text) => {
            if let Some(safe) = sanitize_text(text) {
                *text = safe;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(sanitize_display),
        Value::Object(fields) => fields.values_mut().for_each(sanitize_display),
        _ => (),
    }
}

pub(super) fn sanitize_activation(display: &mut Value) {
    let Some(fields) = display.as_object_mut() else {
        sanitize_display(display);
        return;
    };
    // Activation is the explicit instruction channel. Its metadata has the
    // same display rules as metadata returned by discovery.
    for (key, value) in fields {
        match (key.as_str(), value) {
            ("instructions", Value::String(_)) => (),
            ("skills", Value::Array(skills)) => skills.iter_mut().for_each(sanitize_activation),
            (_, value) => sanitize_display(value),
        }
    }
}
