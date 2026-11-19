use super::{
    super::{EgressTarget, ToolCallContext, ToolName, corpus, decode, invalid},
    predicates::unrestricted,
    scope::targets,
};
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::EpisodeId,
    ports::{
        AgentRetrieval, PageLimit, RecallQuery, RetrievalKind, SearchDegradation, SearchHit,
        SearchQuery,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const MAX_CANDIDATES: usize = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Args {
    query: String,
    project: Option<String>,
    session: Option<EpisodeId>,
    class: Option<DocClass>,
    response_format: Option<Format>,
    limit: Option<u16>,
    budget_tokens: Option<u32>,
    depth: Option<u8>,
    max_per_source: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    Concise,
    Detailed,
}

pub(super) async fn retrieve(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    let args: Args = decode(args)?;
    let recall = name == ToolName::Recall;
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let classes = match args.class {
        Some(DocClass::EncryptedNote) => {
            return Err(invalid(ValidationReason::ClassEgressForbidden));
        }
        Some(class) => BTreeSet::from([class]),
        None => BTreeSet::from([DocClass::UserDoc, DocClass::AgentMemory]),
    };
    let limit = usize::from(args.limit.unwrap_or(if recall { 100 } else { 20 }));
    let budget = args.budget_tokens.unwrap_or(4000);
    let source_budget = args
        .max_per_source
        .map_or(budget / 2, u32::from)
        .min(budget);
    let mut remaining = budget;
    let targets = targets(call, args.project.as_deref(), args.session.as_ref(), true).await?;
    let mut candidates = Vec::new();
    let mut truncated = false;
    let mut degradation = BTreeSet::new();
    let top_k =
        PageLimit::new(u16::try_from(limit).map_err(|_| invalid(ValidationReason::InvalidLimit))?)?;
    for (index, target) in targets.iter().enumerate() {
        let scope = call.space(target.scope.clone())?;
        let query = SearchQuery {
            text: args.query.clone(),
            filter: unrestricted(),
            classes: classes.clone(),
            top_k,
            model: None,
            project: target
                .project
                .as_ref()
                .map(|project| project.folder_id.clone()),
        };
        let result = if recall {
            call.registry
                .engine
                .recall(
                    scope,
                    RecallQuery {
                        query,
                        graph_depth: args.depth.unwrap_or(1),
                        token_budget: budget,
                        max_per_source: Some(
                            u16::try_from(source_budget)
                                .map_err(|_| invalid(ValidationReason::InvalidLimit))?,
                        ),
                    },
                )
                .await?
        } else {
            call.registry.engine.search(scope, query).await?
        };
        target.scope.check(&result.cut.scope)?;
        if result.hits.len() > usize::from(top_k.get()) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        truncated |= result.truncated;
        if let Some(reason) = result.degraded {
            degradation.insert(degraded(reason));
        }
        for hit in result.hits {
            let metadata = hit.card.document.provenance();
            if metadata.reference().space_id != target.scope.space_id || !hit.score.is_finite() {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            if !classes.contains(&metadata.class())
                || target
                    .project
                    .as_ref()
                    .is_some_and(|project| !metadata.in_project(project))
            {
                continue;
            }
            candidates.push(Candidate { index, hit });
        }
        if candidates.len() > MAX_CANDIDATES {
            candidates.sort_by(rank);
            candidates.truncate(MAX_CANDIDATES);
            truncated = true;
        }
    }
    candidates.sort_by(rank);
    let mut seen = BTreeSet::new();
    let mut hits = Vec::new();
    let mut output = Vec::new();
    let mut combined = String::new();
    let mut best = None;

    'candidates: for Candidate { index, hit } in candidates {
        if output.len() >= limit {
            truncated = true;
            break;
        }
        let target = &targets[index];
        let scope = call.space(target.scope.clone())?;
        let metadata = hit.card.document.provenance();
        let reference = metadata.reference();
        let key = (reference.space_id.clone(), reference.note_id.clone());
        if seen.contains(&key) {
            continue;
        }
        let search_parts = if matches!(args.response_format, Some(Format::Detailed)) {
            3
        } else {
            1
        };
        let mut source_remaining = source_budget;
        let heading = format!("## {}\n", reference.note_id);
        let overhead = u32::try_from(heading.len()).unwrap_or(u32::MAX);
        if recall
            && !hit.chunks.iter().any(|chunk| {
                let tokens = chunk.part().tokens();
                tokens <= source_remaining && tokens.saturating_add(overhead + 2) <= remaining
            })
        {
            if !hit.chunks.is_empty() {
                truncated = true;
            }
            continue;
        }
        let origin_count = call.provenance.origins.len();
        let project_count = call.provenance.projects.len();
        match corpus::note_metadata(call, &scope, metadata).await {
            Ok(()) => (),
            Err(error) if corpus::hidden(&error) => continue,
            Err(error) => return Err(error),
        }
        let mut parts = Vec::new();
        for chunk in &hit.chunks {
            if chunk.provenance().reference() != reference
                || chunk.provenance().revision() != metadata.revision()
                || chunk.provenance().digest() != metadata.digest()
            {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            if !recall && parts.len() == search_parts {
                break;
            }
            let tokens = chunk.part().tokens();
            let charge = tokens + 2 + if parts.is_empty() { overhead } else { 0 };
            if recall && (tokens > source_remaining || charge > remaining) {
                truncated = true;
                continue;
            }
            let text = match corpus::search_part(call, &scope, chunk).await {
                Ok(text) => text,
                Err(error) if corpus::hidden(&error) => continue,
                Err(error) => return Err(error),
            };
            if recall {
                source_remaining -= tokens;
                remaining -= charge;
            }
            parts.push(text);
        }
        if recall {
            if parts.is_empty() {
                call.provenance.origins.truncate(origin_count);
                call.provenance.projects.truncate(project_count);
                continue 'candidates;
            }
            combined.push_str(&heading);
            for part in &parts {
                combined.push_str(part);
                combined.push_str("\n\n");
            }
        }

        let mut item = json!({
            "noteId": reference.note_id,
            "spaceId": reference.space_id,
            "versionToken": metadata.revision(),
            "title": hit.card.title,
            "path": hit.card.path,
            "class": metadata.class(),
        });
        if external {
            item["score"] = json!(hit.score);
        }
        if !recall {
            item["snippet"] = json!(parts.first());
            if matches!(args.response_format, Some(Format::Detailed)) {
                item["chunks"] = json!(parts);
            }
        }
        best.get_or_insert(hit.score);
        seen.insert(key);
        hits.push(reference.clone());
        output.push(item);
    }

    let kind = if recall || (call.registry.vector_search && degradation.is_empty()) {
        RetrievalKind::Hybrid
    } else {
        RetrievalKind::FullText
    };
    call.registry
        .telemetry
        .record_agent_retrieval(
            call.account(),
            AgentRetrieval {
                id: call.call_id.clone(),
                call: Some(call.call_id.clone()),
                kind,
                result_count: u32::try_from(hits.len())
                    .map_err(|_| DomainError::validation(ValidationReason::InvalidLimit))?,
                hits,
                top_score: best,
            },
        )
        .await?;

    let mut result = if recall {
        json!({"sources": output, "context": combined, "tokens": budget - remaining,
            "degraded": degradation})
    } else {
        json!({"results": output, "degraded": degradation})
    };
    if external {
        result["truncated"] = json!(truncated);
    }
    Ok(result)
}

struct Candidate {
    index: usize,
    hit: SearchHit,
}

fn rank(left: &Candidate, right: &Candidate) -> std::cmp::Ordering {
    let left_ref = left.hit.card.document.provenance().reference();
    let right_ref = right.hit.card.document.provenance().reference();
    right
        .hit
        .score
        .total_cmp(&left.hit.score)
        .then_with(|| left_ref.space_id.cmp(&right_ref.space_id))
        .then_with(|| left_ref.note_id.cmp(&right_ref.note_id))
}

fn degraded(reason: SearchDegradation) -> &'static str {
    match reason {
        SearchDegradation::EmbeddingsPending => "embeddings_pending",
        SearchDegradation::ModelUnavailable => "model_unavailable",
        SearchDegradation::ProviderUnavailable => "provider_unavailable",
        SearchDegradation::BudgetExceeded => "budget_exceeded",
    }
}
