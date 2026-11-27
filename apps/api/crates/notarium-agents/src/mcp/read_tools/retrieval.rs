use super::{
    super::{EgressTarget, ToolCallContext, ToolName, corpus, decode, derive_digest, invalid},
    predicates::unrestricted,
    scope::targets,
};
use notarium_core::{
    DomainError,
    classes::{ClassifiedMetadata, DocClass},
    error::{PortError, ValidationReason},
    ids::{EpisodeId, NoteId, RequestId},
    model::FolderRef,
    ports::{
        AgentRetrieval, PageLimit, PortFuture, RecallQuery, RetrievalKind, SearchDegradation,
        SearchHit, SearchQuery, SearchRecipient, SpaceContext,
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

struct Recipient<'a, 'registry> {
    call: &'a ToolCallContext<'registry>,
    scope: &'a SpaceContext,
    classes: &'a BTreeSet<DocClass>,
    project: Option<&'a FolderRef>,
    source_classes: Option<BTreeSet<DocClass>>,
    source_project: Option<Option<FolderRef>>,
}

impl SearchRecipient for Recipient<'_, '_> {
    fn filters_notes(&self) -> bool {
        !matches!(self.call.target, EgressTarget::ExternalMcp)
    }

    fn admit<'a>(&'a self, card: &'a ClassifiedMetadata) -> PortFuture<'a, bool> {
        Box::pin(async move {
            if !matches_target(card, self.classes, self.project) {
                return Ok(false);
            }
            match corpus::admit_search_card(self.call, self.scope, card, &self.call.policies).await
            {
                Ok(()) => Ok(true),
                Err(error) if corpus::hidden(&error) => Ok(false),
                Err(error) => Err(error),
            }
        })
    }

    fn framing_tokens(&self, note: &NoteId, first_chunk: bool) -> u32 {
        framing_tokens(note, first_chunk)
    }

    fn query_source_classes(&self) -> Option<BTreeSet<DocClass>> {
        self.source_classes.clone()
    }

    fn query_source_project(&self) -> Option<Option<FolderRef>> {
        self.source_project.clone()
    }
}

fn matches_target(
    card: &ClassifiedMetadata,
    classes: &BTreeSet<DocClass>,
    project: Option<&FolderRef>,
) -> bool {
    classes.contains(&card.class())
        && classes.contains(&card.current_class())
        && project.is_none_or(|project| card.in_project(project))
}

fn framing_tokens(note: &NoteId, first_chunk: bool) -> u32 {
    // The heading is "## <note>\n" and each chunk ends with two newlines.
    let heading = if first_chunk {
        4 + note.as_str().len() as u32
    } else {
        0
    };
    heading + 2
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
    // Validate pure query/numeric limits before resolving any target Space so
    // malformed requests never act as zero-taint project-slug oracles.
    if args.query.len() > 4096 {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    let top_k =
        PageLimit::new(u16::try_from(limit).map_err(|_| invalid(ValidationReason::InvalidLimit))?)?;
    let max_per_source = if recall {
        if args.depth.unwrap_or(1) > RecallQuery::MAX_GRAPH_DEPTH {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let source_cap =
            u16::try_from(source_budget).map_err(|_| invalid(ValidationReason::InvalidLimit))?;
        if !(1..=131_072).contains(&budget) || source_cap == 0 {
            return Err(invalid(ValidationReason::TokenBudgetExceeded));
        }
        Some(source_cap)
    } else {
        None
    };
    let mut remaining = budget;
    let resolved = targets(call, args.project.as_deref(), args.session.as_ref(), true).await?;
    let targets = resolved.targets;
    let targeted_project = resolved.targeted_project;
    let mut candidates = Vec::new();
    let mut truncated = false;
    let mut own_degradation = BTreeSet::new();
    let mut foreign_degradation = BTreeSet::new();
    let mut observed_foreign = false;
    let outcome: Result<Value, PortError> = async {
        for (index, target) in targets.iter().enumerate() {
            let mut scope = call.space(target.scope.clone())?;
            let foreign_space = !external
                && scope
                    .auth()
                    .pinned_write_space()
                    .is_some_and(|pin| pin != &target.scope.space_id);
            // Scope remote query intent ids to this tool invocation so multi-step
            // chat/keeper runs sharing one run RequestId can issue repeated search
            // or recall calls without colliding on provider_call_log intent keys.
            let req_digest = derive_digest(
                "notarium.mcp.retrieval.request.v1",
                &[
                    call.request.as_str().as_bytes(),
                    call.request_key.as_str().as_bytes(),
                    if recall { b"recall" } else { b"search" },
                ],
            );
            scope.budget.request = RequestId::from_bytes(
                req_digest.as_bytes()[..16]
                    .try_into()
                    .expect("fixed digest"),
            );
            let mut effective_classes = classes.clone();
            let mut effective_project = target.project.clone();
            let (source_classes, source_project) = if let EgressTarget::InAppProvider {
                primary_project,
                ..
            } = &call.target
            {
                let grant_readable: BTreeSet<DocClass> = scope
                    .auth()
                    .spaces()
                    .get(&target.scope.space_id)
                    .map(|grant| {
                        grant
                            .read_classes
                            .iter()
                            .copied()
                            .filter(|class| *class != DocClass::EncryptedNote)
                            .collect()
                    })
                    .unwrap_or_default();
                let selection_project = target.project.clone().or_else(|| {
                    primary_project
                        .as_ref()
                        .filter(|project| project.space_id == target.scope.space_id)
                        .cloned()
                });
                let selection = match call.provider_selection(&scope, selection_project).await {
                    Ok(Some(selection)) => selection,
                    Ok(None) => continue,
                    Err(error) if corpus::hidden(&error) => continue,
                    Err(error) => return Err(error),
                };
                let allowed: BTreeSet<DocClass> = selection
                    .policy
                    .allowed_classes
                    .into_iter()
                    .filter(|class| grant_readable.contains(class))
                    .collect();
                effective_classes.retain(|class| allowed.contains(class));
                if let Some(confined) = &selection.project_only {
                    if let Some(existing) = &effective_project
                        && existing != confined
                    {
                        continue;
                    }
                    effective_project = Some(confined.clone());
                }
                if foreign_space && targeted_project {
                    // Targeting a consented foreign project observes that Space even
                    // when class intersection leaves no searchable classes or zero hits.
                    call.auth.taint().mark_external_read();
                    observed_foreign = true;
                }
                if effective_classes.is_empty() {
                    continue;
                }
                // Narrow the space auth to the completion provider's live consented
                // classes (`allowed`), NOT `effective_classes` (the requested result
                // filter), so `query_disclosure` sees all consented query-source
                // classes while `SearchQuery.classes` and `Recipient::admit` still
                // restrict all search/recall candidates and graph hops strictly to
                // `effective_classes`.
                scope = match scope.restrict_read_classes(&allowed) {
                    Ok(narrowed) => narrowed,
                    Err(_) => continue,
                };
                if let Some(project) = &effective_project {
                    scope = match scope.restrict_to_project(project) {
                        Ok(narrowed) => narrowed,
                        Err(_) => continue,
                    };
                }
                (Some(allowed), Some(selection.project_only))
            } else {
                (None, None)
            };
            if foreign_space && targeted_project {
                // Targeting a consented foreign project (explicitly or via episode
                // project_hint) observes that Space even when the query returns zero hits.
                call.auth.taint().mark_external_read();
                observed_foreign = true;
            }
            observed_foreign |= foreign_space;
            let query = SearchQuery {
                text: args.query.clone(),
                filter: unrestricted(),
                classes: effective_classes.clone(),
                top_k,
                model: None,
                causal: target.causal(),
                include_chats: false,
                folder: effective_project
                    .as_ref()
                    .map(|project| project.folder_id.clone()),
            };
            // Keep candidate gathering untainted across Spaces so hits dropped by
            // multi-space limit/budget packing never flip cross-space BranchTaint;
            // every hit admitted into `output` below passes live `corpus::*` gates.
            let query_scope = if external {
                scope.clone()
            } else {
                scope.with_preflight_taint()
            };
            let recipient = Recipient {
                call,
                scope: &query_scope,
                classes: &effective_classes,
                project: effective_project.as_ref(),
                source_classes,
                source_project,
            };
            let result = if recall {
                call.registry
                    .engine
                    .recall_for(
                        query_scope.clone(),
                        RecallQuery {
                            query,
                            graph_depth: args.depth.unwrap_or(1),
                            token_budget: budget,
                            max_per_source,
                        },
                        Some(&recipient),
                    )
                    .await
            } else {
                let recipient = (!external).then_some(&recipient as &dyn SearchRecipient);
                call.registry
                    .engine
                    .search_for(query_scope.clone(), query, recipient)
                    .await
            }?;
            target.scope.check(&result.cut.scope)?;
            if result.hits.len() > usize::from(top_k.get()) {
                return Err(invalid(ValidationReason::InvalidState));
            }
            truncated |= result.truncated;
            if let Some(reason) = result.degraded {
                if foreign_space {
                    foreign_degradation.insert(degraded(reason));
                } else {
                    own_degradation.insert(degraded(reason));
                }
            }
            for hit in result.hits {
                let metadata = hit.card.document.provenance();
                if metadata.reference().space_id != target.scope.space_id || !hit.score.is_finite()
                {
                    return Err(invalid(ValidationReason::SourceMismatch));
                }
                if !matches_target(metadata, &classes, target.project.as_ref()) {
                    continue;
                }
                candidates.push(Candidate { index, hit });
            }
            if external && candidates.len() > MAX_CANDIDATES {
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

        if recall {
            struct RecalledNote {
                hit: notarium_core::ports::SearchHit,
                scope: SpaceContext,
                selection: Option<super::super::ProviderSelection>,
                source_remaining: u32,
                parts: Vec<String>,
                next_chunk_idx: usize,
            }

            // Pass 1: admit up to `limit` distinct notes in global score order,
            // taking each note's best eligible chunk first so secondary chunks of
            // one Space cannot starve higher-scoring hits from other Spaces.
            let mut recalled: Vec<RecalledNote> = Vec::new();
            for Candidate { index, hit } in candidates {
                if recalled.len() >= limit {
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
                if !hit.chunks.iter().any(|chunk| {
                    let tokens = chunk.part().tokens();
                    tokens <= source_budget
                        && tokens.saturating_add(framing_tokens(&reference.note_id, true))
                            <= remaining
                }) {
                    if !hit.chunks.is_empty() {
                        truncated = true;
                    }
                    continue;
                }
                let provenance_checkpoint = call.provenance_checkpoint();
                let selection = match corpus::note_metadata_selection(call, &scope, metadata).await
                {
                    Ok(selection) => selection,
                    Err(error) if corpus::hidden(&error) => continue,
                    Err(error) => return Err(error),
                };
                let mut first_part = None;
                for (chunk_idx, chunk) in hit.chunks.iter().enumerate() {
                    if chunk.provenance().reference() != reference
                        || chunk.provenance().revision() != metadata.revision()
                        || chunk.provenance().digest() != metadata.digest()
                    {
                        return Err(invalid(ValidationReason::SourceMismatch));
                    }
                    let tokens = chunk.part().tokens();
                    let charge = tokens + framing_tokens(&reference.note_id, true);
                    if tokens > source_budget || charge > remaining {
                        truncated = true;
                        continue;
                    }
                    let text = match corpus::search_part_with_selection(
                        call,
                        &scope,
                        metadata,
                        chunk,
                        selection.as_ref(),
                    )
                    .await
                    {
                        Ok(text) => text,
                        Err(error) if corpus::hidden(&error) => continue,
                        Err(error) => return Err(error),
                    };
                    remaining -= charge;
                    first_part = Some((text, source_budget - tokens, chunk_idx + 1));
                    break;
                }
                let Some((text, source_remaining, next_chunk_idx)) = first_part else {
                    call.rollback_provenance(provenance_checkpoint);
                    continue;
                };
                best.get_or_insert(hit.score);
                seen.insert(key);
                recalled.push(RecalledNote {
                    hit,
                    scope,
                    selection,
                    source_remaining,
                    parts: vec![text],
                    next_chunk_idx,
                });
            }

            // Pass 2: pack additional chunks from admitted notes in rank order
            // while per-source and overall token budgets allow.
            for entry in &mut recalled {
                let metadata = entry.hit.card.document.provenance();
                let reference = metadata.reference();
                for chunk in &entry.hit.chunks[entry.next_chunk_idx..] {
                    if chunk.provenance().reference() != reference
                        || chunk.provenance().revision() != metadata.revision()
                        || chunk.provenance().digest() != metadata.digest()
                    {
                        return Err(invalid(ValidationReason::SourceMismatch));
                    }
                    let tokens = chunk.part().tokens();
                    let charge = tokens + framing_tokens(&reference.note_id, false);
                    if tokens > entry.source_remaining || charge > remaining {
                        truncated = true;
                        continue;
                    }
                    let text = match corpus::search_part_with_selection(
                        call,
                        &entry.scope,
                        metadata,
                        chunk,
                        entry.selection.as_ref(),
                    )
                    .await
                    {
                        Ok(text) => text,
                        Err(error) if corpus::hidden(&error) => continue,
                        Err(error) => return Err(error),
                    };
                    entry.source_remaining -= tokens;
                    remaining -= charge;
                    entry.parts.push(text);
                }
            }

            for entry in recalled {
                let metadata = entry.hit.card.document.provenance();
                let reference = metadata.reference();
                combined.push_str(&format!("## {}\n", reference.note_id));
                for part in &entry.parts {
                    combined.push_str(part);
                    combined.push_str("\n\n");
                }
                let mut item = json!({
                    "noteId": reference.note_id,
                    "spaceId": reference.space_id,
                    "versionToken": metadata.revision(),
                    "title": entry.hit.card.title,
                    "path": entry.hit.card.path,
                    "class": metadata.class(),
                });
                if external {
                    item["score"] = json!(entry.hit.score);
                }
                hits.push(reference.clone());
                output.push(item);
            }
        } else {
            for Candidate { index, hit } in candidates {
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
                let selection = match corpus::note_metadata_selection(call, &scope, metadata).await
                {
                    Ok(selection) => selection,
                    Err(error) if corpus::hidden(&error) => continue,
                    Err(error) => return Err(error),
                };
                match corpus::admit_metadata_with_selection(
                    call,
                    &scope,
                    metadata,
                    selection.as_ref(),
                )
                .await
                {
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
                    if parts.len() == search_parts {
                        break;
                    }
                    let text = match corpus::search_part_with_selection(
                        call,
                        &scope,
                        metadata,
                        chunk,
                        selection.as_ref(),
                    )
                    .await
                    {
                        Ok(text) => text,
                        Err(error) if corpus::hidden(&error) => continue,
                        Err(error) => return Err(error),
                    };
                    parts.push(text);
                }
                let mut item = json!({
                    "noteId": reference.note_id,
                    "spaceId": reference.space_id,
                    "versionToken": metadata.revision(),
                    "title": hit.card.title,
                    "path": hit.card.path,
                    "class": metadata.class(),
                    "snippet": parts.first(),
                });
                if external {
                    item["score"] = json!(hit.score);
                }
                if matches!(args.response_format, Some(Format::Detailed)) {
                    item["chunks"] = json!(parts);
                }
                best.get_or_insert(hit.score);
                seen.insert(key);
                hits.push(reference.clone());
                output.push(item);
            }
        }

        let mut degradation = own_degradation;
        if call.auth.taint().is_tainted() {
            degradation.extend(foreign_degradation);
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
    .await;
    outcome.inspect_err(|_| {
        if observed_foreign {
            call.commit_external_read();
        }
    })
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
