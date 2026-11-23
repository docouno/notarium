use super::{
    super::{
        EgressTarget, ToolCallContext, command_actor, corpus, decode, invalid, note_tools, session,
    },
    cursor::NoteContinuation,
    predicates::Filters,
    scope::{ReadTarget, targets},
};
use notarium_core::{
    DomainError,
    auth::ResourceFacts,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, EpisodeId},
    model::{Lifecycle, LifecycleMask},
    ports::{FolderSnapshot, GetNote, NoteQuery, PageLimit, SpaceContext},
    query::{ReadRequest, SortSpec},
    receipt::CausalBasis,
};
use notarium_syntax::unicode::lookup_key;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Args {
    project: Option<String>,
    path: Option<String>,
    tag: Option<String>,
    cursor: Option<String>,
    limit: Option<u16>,
    session: Option<EpisodeId>,
    #[serde(flatten)]
    fields: Filters,
}

pub(super) async fn list(call: &mut ToolCallContext<'_>, args: Value) -> Result<Value, PortError> {
    let args: Args = decode(args)?;
    let Some(target) = targets(call, args.project.as_deref(), args.session.as_ref(), false)
        .await?
        .into_iter()
        .next()
    else {
        return Ok(empty());
    };
    let scope = call.space(target.scope.clone())?;
    let limit = PageLimit::new(args.limit.unwrap_or(50))?;
    let Some(folder) = directory(call, &target, &scope, args.path.as_deref()).await? else {
        if args.cursor.is_some() {
            return Err(invalid(ValidationReason::CursorStale));
        }
        return Ok(empty());
    };
    let folder_info = match corpus::folder_metadata(call, &scope, &folder).await {
        Ok(info) => info,
        Err(error) if corpus::hidden(&error) => {
            if args.cursor.is_some() {
                return Err(invalid(ValidationReason::CursorStale));
            }
            return Ok(empty());
        }
        Err(error) => return Err(error),
    };
    let schema = if args.fields.is_empty() {
        BTreeMap::new()
    } else {
        call.registry.engine.space_schema(scope.clone()).await?
    };
    let filter = args.fields.compile(&schema)?;
    let tag = args.tag.map(|tag| lookup_key(&tag));
    let auth = scope.auth();
    let grant = auth
        .spaces()
        .get(&folder.reference.space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    let receiver = match &call.target {
        EgressTarget::ExternalMcp => None,
        EgressTarget::InAppProvider {
            provider,
            model,
            primary_project,
        } => Some((provider, model, primary_project)),
    };
    let encoded = serde_json::to_vec(&(
        auth.principal(),
        command_actor(auth),
        auth.bearer_scope(),
        receiver,
        grant.role,
        &grant.read_classes,
        &grant.project_root,
        &target.project,
        &folder.reference,
        &filter,
        &tag,
        limit.get(),
    ))
    .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let fingerprint = ContentDigest::from_bytes(*blake3::hash(&encoded).as_bytes());
    let previous = args
        .cursor
        .as_deref()
        .map(|raw| call.registry.note_cursors.open(raw))
        .transpose()?;
    if let Some(previous) = &previous {
        scope.scope().check(&previous.scope)?;
        if previous.folder != folder.reference || previous.fingerprint != fingerprint {
            return Err(invalid(ValidationReason::CursorScopeMismatch));
        }
    }

    let request = if let Some(previous) = &previous {
        previous
            .notes
            .clone()
            .map(|cursor| ReadRequest::Continue { cursor })
    } else {
        Some(ReadRequest::Open {
            query: NoteQuery {
                folder: Some(folder.reference.folder_id.clone()),
                recursive: false,
                classes: [DocClass::UserDoc].into(),
                lifecycle: LifecycleMask::Active,
                filter,
                tag,
                sort: SortSpec::default(),
                limit,
            },
            causal: target.causal(),
        })
    };
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let mut items = Vec::new();
    let mut next_notes = None;
    let mut incomplete = false;
    let mut total = if external {
        previous.as_ref().and_then(|cursor| cursor.total)
    } else {
        None
    };
    if let Some(request) = request {
        let page = call
            .registry
            .engine
            .list_notes(scope.clone(), request)
            .await?;
        scope.scope().check(&page.children.scope)?;
        if page.folder != folder.reference || page.children.items.len() > usize::from(limit.get()) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if external {
            total = Some(page.total);
        }
        incomplete = page.children.incomplete;
        next_notes = page.children.next;
        for card in page.children.items {
            let metadata = card.document.provenance();
            if metadata.class() != DocClass::UserDoc
                || folder.cover_note.as_ref() == Some(&metadata.reference().note_id)
            {
                continue;
            }
            match corpus::note_metadata(call, &scope, metadata).await {
                Ok(()) => items.push(json!({
                    "noteId": metadata.reference().note_id,
                    "versionToken": metadata.revision(),
                    "title": card.title,
                    "path": card.path,
                    "tags": card.tags,
                    "viewType": card.view_type,
                })),
                Err(error) if corpus::hidden(&error) => (),
                Err(error) => return Err(error),
            }
        }
    }

    let mut folders = Vec::new();
    let mut next_folders = None;
    if previous
        .as_ref()
        .is_none_or(|cursor| cursor.folders.is_some())
    {
        let after = previous.and_then(|cursor| cursor.folders);
        let page = call
            .registry
            .engine
            .list_child_folders(
                scope.clone(),
                Some(folder.reference.folder_id.clone()),
                after.clone(),
                limit,
            )
            .await?;
        if page.items.len() > usize::from(limit.get())
            || page
                .next
                .as_ref()
                .is_some_and(|next| after.as_ref().is_some_and(|after| next <= after))
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        next_folders = page.next;
        for child in page.items {
            if child.history != folder.history
                || child.parent.as_ref() != Some(&folder.reference.folder_id)
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            match corpus::folder_metadata(call, &scope, &child).await {
                Ok(card) => folders.push(card),
                Err(error) if corpus::hidden(&error) => (),
                Err(error) => return Err(error),
            }
        }
    }
    let mut output = json!({ "items": items, "folders": folders });
    if incomplete {
        output["incomplete"] = json!(true);
    }
    if let Some(total) = total {
        output["total"] = json!(total);
    }
    if next_notes.is_some() || next_folders.is_some() {
        let token = call.registry.note_cursors.insert(
            call.auth.principal().clone(),
            NoteContinuation {
                folder: folder.reference.clone(),
                scope: folder.history.clone(),
                fingerprint,
                notes: next_notes,
                folders: next_folders,
                total,
            },
        )?;
        output["nextCursor"] = json!(token);
    }
    let handle = if let Some(handle) = args.project {
        Some(handle)
    } else if external && folder.cover_note.is_none() {
        if let Some(project) = &target.project {
            let source = session::project_for_folder(call, project).await?;
            Some(format!("{}/{}", target.slug, source.project_slug))
        } else {
            None
        }
    } else {
        None
    };
    if let Some(page) = folder_page(call, &scope, &folder, &folder_info, handle.as_deref()).await? {
        output["folderPage"] = page;
    }
    Ok(output)
}

async fn directory(
    call: &ToolCallContext<'_>,
    target: &ReadTarget,
    scope: &SpaceContext,
    path: Option<&str>,
) -> Result<Option<FolderSnapshot>, PortError> {
    let path = note_tools::clean_path(path.unwrap_or_default())?;
    let engine = &call.registry.engine;
    let Some(project) = &target.project else {
        return engine.resolve_folder_path(scope.clone(), None, path).await;
    };
    let base = Some(project.folder_id.clone());
    let Some(home) = engine
        .resolve_folder_path(scope.clone(), base.clone(), String::new())
        .await?
    else {
        return Ok(None);
    };
    scope.scope().check(&home.history)?;
    if home.reference != *project {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if path.is_empty() {
        return Ok(Some(home));
    }
    if let Some(relative) = corpus::strip_folder_prefix(&path, &home.path) {
        return engine
            .resolve_folder_path(scope.clone(), base, relative)
            .await;
    }

    // A whole-Space credential can also follow an older Space-relative alias.
    if scope
        .auth()
        .spaces()
        .get(&project.space_id)
        .is_some_and(|grant| grant.project_root.is_none())
        && let Some(folder) = engine
            .resolve_folder_path(scope.clone(), None, path.clone())
            .await?
        && folder.project.as_ref() == Some(&project.folder_id)
    {
        return Ok(Some(folder));
    }
    engine.resolve_folder_path(scope.clone(), base, path).await
}

async fn folder_page(
    call: &mut ToolCallContext<'_>,
    scope: &SpaceContext,
    folder: &FolderSnapshot,
    folder_info: &Value,
    handle: Option<&str>,
) -> Result<Option<Value>, PortError> {
    let marker = |status: &str| {
        json!({
            "status": status,
            "folderId": folder.reference.folder_id,
            "folderPath": folder_info["path"],
        })
    };
    if let Some(id) = &folder.cover_note {
        match corpus::note_in_space(call, scope, id).await {
            Ok(note) if note.facts.class == DocClass::UserDoc => (),
            Ok(_) => return Ok(None),
            Err(error) if corpus::hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        }
        let note = call
            .registry
            .engine
            .get_note_metadata(
                scope.clone(),
                GetNote {
                    note: id.clone(),
                    revision: None,
                    causal: CausalBasis::Await(Default::default()),
                },
            )
            .await;
        let note = match note {
            Ok(note) => note,
            Err(error) if corpus::hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let metadata = &note.metadata;
        if metadata.reference().note_id != *id
            || metadata.class() != DocClass::UserDoc
            || (note.parent.as_ref() != Some(&folder.reference.folder_id)
                && (note.parent.is_some() || folder.parent.is_some()))
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        match corpus::note_metadata(call, scope, metadata).await {
            Ok(()) => {
                let mut page = marker("present");
                page["noteId"] = json!(id);
                page["versionToken"] = json!(metadata.revision());
                page["title"] = json!(note.provenance.as_ref().map(|facts| &facts.title));
                return Ok(Some(page));
            }
            Err(error) if corpus::hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    let mut page = marker("missing");
    if let Some(handle) = handle {
        let facts = match call
            .registry
            .catalog
            .folder(call.account(), folder.reference.clone())
            .await
        {
            Ok(facts)
                if facts.reference == folder.reference
                    && facts.lifecycle == Lifecycle::Active
                    && facts.space.id == folder.reference.space_id =>
            {
                facts
            }
            Ok(_) => return Err(invalid(ValidationReason::SourceMismatch)),
            Err(error) if corpus::hidden(&error) => return Ok(Some(page)),
            Err(error) => return Err(error),
        };
        let resource = ResourceFacts {
            space: facts.space,
            class: DocClass::UserDoc,
            project: None,
            ancestor_folders: facts.ancestor_folders,
            folder_write_locked: facts.write_locked,
            ability_package: None,
        };
        if scope
            .auth()
            .authorize_direct_write(&resource, &resource)
            .is_ok()
        {
            page["createWith"] =
                json!({ "project": handle, "path": folder_info["path"], "folderPage": true });
        }
    }
    Ok(Some(page))
}

fn empty() -> Value {
    json!({ "items": [], "folders": [], "total": 0 })
}
