use super::{EgressTarget, ToolCallContext, corpus, invalid, session};
use notarium_core::{
    DomainError,
    document::{ViewBlock, ViewState},
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{ContentDigest, NoteId, SpaceSeq},
    ports::{
        GetNote, GraphNodeId, GraphQuery, GraphTier, PageLimit, SpaceContext, ViewQuery, ViewRef,
    },
    query::{FieldFilterAstV1, Predicate, ReadRequest},
    receipt::{AwaitWatermarks, CausalBasis},
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
    tokio::time::timeout_at(call.deadline, read(call, args))
        .await
        .map_err(|_| {
            PortError::DeadlineExceeded(
                OperationalFailure::new(
                    ContentDigest::from_bytes(*blake3::hash(b"mcp get_note deadline").as_bytes()),
                    CommitEffect::NotCommitted,
                    RetryAdvice::Never,
                    false,
                )
                .expect("read-only deadline"),
            )
        })?
}

async fn read(call: &mut ToolCallContext<'_>, args: Value) -> Result<NoteOutput, PortError> {
    let note = NoteId::parse(
        args["ref"]
            .as_str()
            .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?,
    )?;
    let detailed = args["responseFormat"].as_str() != Some("concise");
    let (ctx, _) = corpus::locate_note_preflight(call, &note).await?;
    let snapshot = call
        .registry
        .engine
        .get_note(
            ctx.with_preflight_taint(),
            GetNote {
                note: note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
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
            && let Some(folder) = call
                .registry
                .engine
                .resolve_folder_path(
                    call.space(ctx.scope().clone())?.with_preflight_taint(),
                    snapshot.parent,
                    String::new(),
                )
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

    // Observe the Space after reading the carrier so the derived reads include
    // both the returned view definition and writes to its candidate notes.
    let head = if detailed {
        let space = session::readable_space(call, &ctx.scope().space_id).await?;
        ctx.scope().check(&space.history)?;
        Some(space.last_seq)
    } else {
        None
    };
    let mut display_body = String::new();
    let mut offset = header.carrier.body.start();
    let mut views_out = Vec::with_capacity(views.len());
    let mut view_budget = MAX_VIEW_ROWS;
    let mut view_rows_truncated = false;
    for (index, view) in views.into_iter().enumerate() {
        display_body.push_str(&carrier[offset..view.span.start()]);
        let result = describe_view(
            call,
            &ctx,
            (&note, snapshot.document.revision()),
            &view,
            index,
            head,
            &mut view_budget,
        )
        .await?;
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
    if let Some(head) = head {
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
        payload["links"] = graph(call, &ctx, &note, head).await?;
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
    (note, note_revision): (&NoteId, &notarium_core::ids::RevisionId),
    view: &ViewBlock,
    index: usize,
    head: Option<SpaceSeq>,
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
    let Some(head) = head else {
        return Ok(item);
    };
    if index >= MAX_VIEW_QUERIES || *remaining == 0 {
        item["status"] = json!("incomplete");
        item["rowsTruncated"] = json!(true);
        return Ok(item);
    }
    const MAX_VIEW_SCAN_PAGES: usize = 8;
    let budget = *remaining;
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let page_limit = PageLimit::new(if external {
        budget as u16
    } else {
        (budget as u16).max(MAX_VIEW_ROWS as u16)
    })?;
    let mut request = ReadRequest::Open {
        query: ViewQuery {
            view: ViewRef {
                note: note.clone(),
                key: key.clone(),
            },
            filter: unconstrained(),
            sort: None,
            group_by: None,
            limit: page_limit,
        },
        causal: CausalBasis::Await(AwaitWatermarks::at(ctx.scope().clone(), head)),
    };
    let mut rows = Vec::new();
    let mut rows_truncated = false;
    let mut page_incomplete = false;
    let mut projected_seq = head;
    let mut canonical_seq = head;
    let mut groups = None;
    for page_idx in 0..MAX_VIEW_SCAN_PAGES {
        let result = call
            .registry
            .engine
            .query_view(call.space(ctx.scope().clone())?, request)
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
        if &page.view_revision != note_revision {
            item["status"] = json!("incomplete");
            return Ok(item);
        }
        if page_idx == 0 {
            projected_seq = page.rows.projected_seq;
            canonical_seq = page.rows.canonical_seq;
            if external {
                groups = Some(page.groups);
            }
        }
        page_incomplete |= page.rows.incomplete;
        for row in page.rows.items {
            let proof = row.card.document.provenance();
            match corpus::note_metadata(call, ctx, proof).await {
                Ok(()) => {
                    if *remaining == 0 {
                        rows_truncated = true;
                        break;
                    }
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
        if rows_truncated {
            break;
        }
        let Some(next_cursor) = page.rows.next else {
            break;
        };
        if external {
            rows_truncated = true;
            break;
        }
        if page_idx + 1 == MAX_VIEW_SCAN_PAGES {
            rows_truncated = true;
            break;
        }
        request = ReadRequest::Continue {
            cursor: next_cursor,
        };
    }
    let incomplete = page_incomplete || projected_seq < head.max(canonical_seq) || rows_truncated;
    item["status"] = json!(if incomplete { "incomplete" } else { "ready" });
    item["rows"] = Value::Array(rows);
    if rows_truncated {
        item["rowsTruncated"] = json!(true);
    }
    if let Some(page_groups) = groups {
        let total_groups = page_groups.len();
        item["groups"] = Value::Array(
            page_groups
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
    head: SpaceSeq,
) -> Result<Value, PortError> {
    let result = call
        .registry
        .engine
        .query_graph(
            call.space(ctx.scope().clone())?,
            GraphQuery {
                tier: GraphTier::Neighborhood {
                    note: note.clone(),
                    hops: 1,
                },
                filter: unconstrained(),
                causal: Some(CausalBasis::Await(AwaitWatermarks::at(
                    ctx.scope().clone(),
                    head,
                ))),
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
    let incomplete = graph.cut.projected_seq < head.max(graph.cut.canonical_seq)
        || (matches!(call.target, EgressTarget::ExternalMcp)
            && (graph.truncated || graph.nodes.len() > MAX_LINK_NODES));
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
                if matches!(
                    diagnostic.reason,
                    ValidationReason::NotReady
                        | ValidationReason::InvalidView
                        | ValidationReason::CursorStale
                        | ValidationReason::GenerationMismatch
                )
        )
}

fn unconstrained() -> FieldFilterAstV1 {
    FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::All(Vec::new()),
    }
}
