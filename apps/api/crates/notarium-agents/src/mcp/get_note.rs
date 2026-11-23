use super::{EgressTarget, ToolCallContext, corpus, invalid};
use notarium_core::{
    DomainError,
    document::{ViewBlock, ViewState},
    error::{PortError, ValidationReason},
    ids::NoteId,
    ports::{
        GetNote, GraphNodeId, GraphQuery, GraphTier, PageLimit, SpaceContext, ViewQuery, ViewRef,
    },
    query::{FieldFilterAstV1, Predicate, ReadRequest},
    receipt::CausalBasis,
    value::YamlValue,
};
use notarium_syntax::{frontmatter, markdown, nota};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const MAX_VIEW_ROWS: usize = 50;
const MAX_VIEW_QUERIES: usize = 50;
const MAX_LINK_NODES: usize = 128;

pub(super) struct NoteOutput {
    pub structured: Value,
    pub display: Value,
}

pub(super) async fn get(
    call: &mut ToolCallContext<'_>,
    args: Value,
) -> Result<NoteOutput, PortError> {
    let note = NoteId::parse(
        args["ref"]
            .as_str()
            .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?,
    )?;
    let detailed = args["responseFormat"].as_str() != Some("concise");
    let (ctx, _) = corpus::locate_note(call, &note).await?;
    let snapshot = call
        .registry
        .engine
        .get_note(
            ctx.clone(),
            GetNote {
                note: note.clone(),
                revision: None,
                causal: causal(),
            },
        )
        .await
        .map_err(note_error)?;
    if snapshot.document.reference().note_id != note {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let carrier = corpus::note_document(call, &ctx, &snapshot.document)
        .await
        .map_err(note_error)?;
    let header = frontmatter::analyze(&carrier, snapshot.document.class())?;
    let markdown = markdown::analyze(&carrier, header.carrier.body)?;
    let views = nota::analyze(&carrier, header.carrier.body, &note, &markdown, false)?.blocks;
    let mut omitted = 0;
    let fields = safe_fields(header.fields.unwrap_or_default(), &mut omitted);
    let mut payload = json!({
        "noteId": note,
        "versionToken": snapshot.document.revision(),
        "class": snapshot.document.class(),
        "spaceId": ctx.scope().space_id,
        "frontmatter": fields,
        "unsafeFrontmatterKeysOmitted": omitted,
    });
    if let Some(provenance) = snapshot.provenance {
        payload["title"] = json!(provenance.title);
        payload["path"] = json!(provenance.path);
        payload["projectId"] = json!(provenance.project);
        payload["provenance"] = json!({
            "principal": provenance.principal,
            "modifiedAt": provenance.modified_at,
        });
        if provenance.folder_page
            && let Some(parent) = snapshot.parent
            && let Some(folder) = call
                .registry
                .engine
                .resolve_folder_path(ctx.clone(), Some(parent), String::new())
                .await?
            && folder.cover_note.as_ref() == Some(&note)
        {
            match corpus::folder_metadata(call, &ctx, &folder).await {
                Ok(_) => {
                    payload["folderPage"] = json!({
                        "status": "present",
                        "folderId": folder.reference.folder_id,
                        "folderPath": folder.path,
                        "noteId": note,
                    })
                }
                Err(error) if corpus::hidden(&error) => (),
                Err(error) => return Err(error),
            }
        }
    }

    let mut display_body = String::new();
    let mut offset = header.carrier.body.start();
    let mut views_out = Vec::with_capacity(views.len());
    let mut view_budget = MAX_VIEW_ROWS;
    let mut view_rows_truncated = false;
    for (index, view) in views.into_iter().enumerate() {
        display_body.push_str(&carrier[offset..view.span.start()]);
        let result =
            describe_view(call, &ctx, &note, &view, index, detailed, &mut view_budget).await?;
        view_rows_truncated |= result["rowsTruncated"] == true;
        display_body.push_str("\n[nota view] ");
        display_body.push_str(
            &serde_json::to_string(&result).map_err(|_| invalid(ValidationReason::InvalidState))?,
        );
        display_body.push('\n');
        offset = view.span.end();
        if detailed {
            views_out.push(result);
        }
    }
    display_body.push_str(&carrier[offset..header.carrier.body.end()]);
    if detailed {
        payload["outline"] = Value::Array(
            markdown
                .headings
                .into_iter()
                .map(|heading| {
                    json!({
                        "level": heading.level, "title": heading.title,
                    })
                })
                .collect(),
        );
        payload["links"] = graph(call, &ctx, &note).await?;
        if !views_out.is_empty() {
            payload["views"] = Value::Array(views_out);
            if view_rows_truncated {
                payload["viewRowsTruncated"] = Value::Bool(true);
            }
        }
    }
    let mut display = payload.clone();
    display["content"] = Value::String(display_body);
    payload["content"] = Value::String(carrier);
    Ok(NoteOutput {
        structured: payload,
        display,
    })
}

async fn describe_view(
    call: &mut ToolCallContext<'_>,
    ctx: &SpaceContext,
    note: &NoteId,
    view: &ViewBlock,
    index: usize,
    detailed: bool,
    remaining: &mut usize,
) -> Result<Value, PortError> {
    let mut item = json!({"block": index + 1});
    let Some(key) = &view.id else {
        item["status"] = json!("invalid");
        return Ok(item);
    };
    if view.state != ViewState::Ready {
        item["status"] = json!("invalid");
        return Ok(item);
    }
    item["viewRef"] = json!(format!("{note}:{key}"));
    if !detailed {
        return Ok(item);
    }
    if index >= MAX_VIEW_QUERIES || *remaining == 0 {
        item["status"] = json!("incomplete");
        item["rowsTruncated"] = json!(true);
        return Ok(item);
    }
    let limit = *remaining as u16;
    let result = call
        .registry
        .engine
        .query_view(
            ctx.clone(),
            ReadRequest::Open {
                query: ViewQuery {
                    view: ViewRef {
                        note: note.clone(),
                        key: key.clone(),
                    },
                    filter: unconstrained(),
                    sort: None,
                    group_by: None,
                    limit: PageLimit::new(limit)?,
                },
                causal: causal(),
            },
        )
        .await;
    let page = match result {
        Ok(page) => page,
        Err(error) if optional_projection(&error) => {
            item["status"] = json!("incomplete");
            return Ok(item);
        }
        Err(error) => return Err(error),
    };
    ctx.scope().check(&page.rows.scope)?;
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let mut rows = Vec::new();
    let truncated =
        external && (page.rows.next.is_some() || page.rows.items.len() > usize::from(limit));
    for row in page.rows.items.into_iter().take(usize::from(limit)) {
        let proof = row.card.document.provenance();
        match corpus::note_metadata(call, ctx, proof).await {
            Ok(()) => {
                rows.push(json!({
                    "id": proof.reference().note_id,
                    "title": row.card.title,
                    "filePath": row.card.path,
                    "group": row.group,
                }));
                *remaining -= 1;
            }
            Err(error) if corpus::hidden(&error) => (),
            Err(error) => return Err(error),
        }
    }
    let incomplete = page.rows.incomplete || truncated;
    item["status"] = json!(if incomplete { "incomplete" } else { "ready" });
    item["rows"] = Value::Array(rows);
    if truncated {
        item["rowsTruncated"] = json!(true);
    }
    if external {
        let total_groups = page.groups.len();
        item["groups"] = Value::Array(
            page.groups
                .into_iter()
                .take(MAX_VIEW_ROWS)
                .map(|group| {
                    json!({
                        "group": group.group, "count": group.count,
                    })
                })
                .collect(),
        );
        if total_groups > MAX_VIEW_ROWS {
            item["groupsTruncated"] = json!(true);
        }
    }
    Ok(item)
}

async fn graph(
    call: &mut ToolCallContext<'_>,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<Value, PortError> {
    let result = call
        .registry
        .engine
        .query_graph(
            ctx.clone(),
            GraphQuery {
                tier: GraphTier::Neighborhood {
                    note: note.clone(),
                    hops: 1,
                },
                filter: unconstrained(),
            },
        )
        .await;
    let graph = match result {
        Ok(graph) => graph,
        Err(error) if optional_projection(&error) => {
            return Ok(json!({"status": "incomplete", "edges": []}));
        }
        Err(error) => return Err(error),
    };
    ctx.scope().check(&graph.cut.scope)?;
    let mut admitted = BTreeSet::from([note.clone()]);
    let incomplete = matches!(call.target, EgressTarget::ExternalMcp)
        && (graph.truncated || graph.nodes.len() > MAX_LINK_NODES);
    for node in graph.nodes.into_iter().take(MAX_LINK_NODES) {
        let (GraphNodeId::Note(id), Some(card)) = (node.id, node.card) else {
            continue;
        };
        let proof = card.document.provenance();
        if proof.reference().note_id != id {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        match corpus::note_metadata(call, ctx, proof).await {
            Ok(()) => {
                admitted.insert(id);
            }
            Err(error) if corpus::hidden(&error) => (),
            Err(error) => return Err(error),
        }
    }
    let edges: Vec<_> = graph
        .edges
        .into_iter()
        .filter_map(|edge| match (edge.source, edge.target) {
            (GraphNodeId::Note(source), GraphNodeId::Note(target))
                if admitted.contains(&source) && admitted.contains(&target) =>
            {
                Some(json!({"from": source, "to": target, "weight": edge.weight}))
            }
            _ => None,
        })
        .collect();
    Ok(json!({"status": if incomplete { "incomplete" } else { "ready" }, "edges": edges}))
}

fn safe_fields(
    fields: std::collections::BTreeMap<String, YamlValue>,
    omitted: &mut usize,
) -> Map<String, Value> {
    fields
        .into_iter()
        .filter_map(|(key, value)| {
            if corpus::validate_field_key(&key).is_err() {
                *omitted += 1;
                None
            } else {
                Some((key, yaml_json(value, omitted)))
            }
        })
        .collect()
}

fn yaml_json(value: YamlValue, omitted: &mut usize) -> Value {
    match value {
        YamlValue::Null => Value::Null,
        YamlValue::Bool(value) => Value::Bool(value),
        YamlValue::String(value) => Value::String(value),
        YamlValue::Number(value) => Value::Number(value.as_json().clone()),
        YamlValue::Sequence(items) => Value::Array(
            items
                .into_iter()
                .map(|item| yaml_json(item, omitted))
                .collect(),
        ),
        YamlValue::Mapping(fields) => Value::Object(safe_fields(fields, omitted)),
    }
}

fn note_error(error: PortError) -> PortError {
    if corpus::hidden(&error) {
        DomainError::ResourceNotFound.into()
    } else {
        error
    }
}

fn optional_projection(error: &PortError) -> bool {
    matches!(error, PortError::Unavailable(_))
        || corpus::hidden(error)
        || matches!(
            error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
                if matches!(diagnostic.reason, ValidationReason::NotReady | ValidationReason::InvalidView)
        )
}

fn unconstrained() -> FieldFilterAstV1 {
    FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::All(Vec::new()),
    }
}

fn causal() -> CausalBasis {
    CausalBasis::Await(Default::default())
}
