use notarium_core::{
    error::{CommitEffect, OperationalFailure, RetryAdvice},
    ids::SpaceSeq,
    ports::{ChangeKind, ChangeRead, ChangeReadResult, ChatProposalWitness, EntityId, PageLimit},
    receipt::{ChangeCursor, MutationReceiptToken},
};

use crate::mcp::{EgressTarget, derive_digest};

use super::*;

type Source = (HistoryScope, NoteId);

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(in crate::mcp) enum ProposalLink {
    Ready(LinkPlan),
    Rejected { error: String },
}

fn human(call: &ToolCallContext<'_>) -> Result<(), PortError> {
    call.auth.authorize_human_management()?;
    if call.auth.taint().is_tainted() {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    if !matches!(call.target, EgressTarget::ExternalMcp) {
        return Err(DomainError::AccessDenied.into());
    }
    Ok(())
}

fn proposal_class(class: DocClass) -> Result<(), PortError> {
    if matches!(class, DocClass::UserDoc | DocClass::AgentMemory) {
        Ok(())
    } else {
        Err(DomainError::SpaceReadOnly.into())
    }
}

pub(in crate::mcp) async fn plan_links(
    call: &ToolCallContext<'_>,
    provider: &ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Vec<ProposalLink>, PortError> {
    human(call)?;
    let links = match name {
        ToolName::Link => vec![decode(args)?],
        ToolName::LinkMany => decode::<LinkManyInput>(args)?.links,
        _ => return Err(DomainError::ResourceNotFound.into()),
    };
    if links.is_empty() || links.len() > 100 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let mut observed = BTreeMap::<Source, RevisionId>::new();
    let mut planned = Vec::with_capacity(links.len());
    for link in links {
        let attempted = async {
            let source = NoteId::parse(&link.source)?;
            let collapse = |error: PortError| {
                if corpus::hidden(&error) {
                    DomainError::ResourceNotFound.into()
                } else {
                    error
                }
            };
            let (provider_scope, provider_note) = corpus::locate_note(provider, &source)
                .await
                .map_err(collapse)?;
            corpus::admit_provider_note_read(provider, &provider_scope, &provider_note)
                .await
                .map_err(collapse)?;
            let scope = call.space(provider_scope.scope().clone())?;
            let source_note = corpus::note_in_space(call, &scope, &source).await?;
            scope
                .auth()
                .authorize_direct_write(&source_note.facts, &source_note.facts)?;
            proposal_class(source_note.facts.class)?;
            let plan =
                plan_link_located(call, Some(provider), scope, source_note, &link.edge, true)
                    .await?;
            let revision = plan
                .expected_revision
                .clone()
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let source = (plan.scope.clone(), plan.source.clone());
            match observed.entry(source) {
                std::collections::btree_map::Entry::Occupied(earlier)
                    if earlier.get() != &revision =>
                {
                    return Err(DomainError::RevisionConflict {
                        current: revision,
                        lineage: None,
                    }
                    .into());
                }
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(revision);
                }
                std::collections::btree_map::Entry::Occupied(_) => (),
            }
            Ok::<_, PortError>(plan)
        }
        .await;
        match attempted {
            Ok(plan) => planned.push(ProposalLink::Ready(plan)),
            Err(PortError::Domain(error))
                if name == ToolName::LinkMany
                    && !matches!(error, DomainError::RateLimited { .. }) =>
            {
                planned.push(ProposalLink::Rejected {
                    error: error.code().to_owned(),
                });
            }
            Err(error) => return Err(error),
        }
    }
    Ok(planned)
}

pub(super) async fn exact_link_revision(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    source: &NoteId,
    receipt: &MutationReceiptToken,
) -> Result<RevisionId, PortError> {
    scope.scope().check(receipt.scope())?;
    let seq = receipt.seq();
    let after = ChangeCursor {
        scope: receipt.scope().clone(),
        after: SpaceSeq::new(seq.get() - 1)?,
    };
    let result = call
        .registry
        .engine
        .read_changes(
            scope.clone(),
            ChangeRead::Log {
                after,
                through: seq,
                limit: PageLimit::new(1)?,
            },
        )
        .await?;
    let ChangeReadResult::Log(page) = result else {
        return Err(invalid(ValidationReason::SourceMismatch));
    };
    if page.cutoff != seq || page.changes.len() != 1 || page.next.scope != *receipt.scope() {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let change = page.changes.into_iter().next().expect("one result");
    if change.cursor.scope != *receipt.scope()
        || change.cursor.after != seq
        || change.command_range.first_seq != seq
        || change.command_range.last_seq != seq
        || change.entity != EntityId::Note(source.clone())
        || change.kind != ChangeKind::Edit
        || change.lifecycle != Lifecycle::Active
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(change.revision)
}

fn unknown(error: PortError) -> PortError {
    super::super::super::note_tools::batch_operational_error(
        "notarium.confirmed-link-receipt.v1",
        error,
        true,
    )
}

fn post_commit_link_error(error: PortError) -> PortError {
    match unknown(error) {
        PortError::Domain(domain) => PortError::Unavailable(
            OperationalFailure::new(
                derive_digest(
                    "notarium.confirmed-link-receipt.v1",
                    &[domain.code().as_bytes()],
                ),
                CommitEffect::Unknown,
                RetryAdvice::RetrySameCommand,
                true,
            )
            .expect("same-command retry has durable identity"),
        ),
        other => other,
    }
}

pub(in crate::mcp) async fn describe_links(
    call: &ToolCallContext<'_>,
    plans: &[ProposalLink],
) -> Result<Value, PortError> {
    human(call)?;
    let mut output = Vec::with_capacity(plans.len());
    for (index, item) in plans.iter().enumerate() {
        let plan = match item {
            ProposalLink::Ready(plan) => plan,
            ProposalLink::Rejected { error } => {
                output.push(json!({"index": index, "ok": false, "error": error}));
                continue;
            }
        };
        let checked = async {
            let scope = call.space(plan.scope.clone())?;
            proposal_class(authorize(call, &scope, plan).await?)
        }
        .await;
        match checked {
            Ok(()) => (),
            Err(PortError::Domain(error)) if !matches!(error, DomainError::RateLimited { .. }) => {
                output.push(json!({"index": index, "ok": false, "error": error.code()}));
                continue;
            }
            Err(error) => return Err(error),
        }
        let target = match &plan.target {
            Target::Stable { note, alias } => json!({
                "noteId": note,
                "label": alias.as_ref().map(|alias| alias.title.as_str()),
            }),
            Target::Authored { name } => json!({"title": name}),
        };
        output.push(json!({
            "index": index,
            "ok": true,
            "source": {
                "spaceId": plan.scope.space_id,
                "noteId": plan.source,
                "expectedRevision": plan.expected_revision,
            },
            "target": target,
            "relation": plan.relation,
        }));
    }
    Ok(json!({"links": output}))
}

pub(in crate::mcp) async fn apply_links(
    call: &ToolCallContext<'_>,
    name: ToolName,
    plans: &[ProposalLink],
    witness: &ChatProposalWitness,
    mut step_identity: impl FnMut(u16, &HistoryScope) -> Result<CommandIdentity, PortError> + Send,
) -> Result<Value, PortError> {
    human(call)?;
    if !matches!(name, ToolName::Link | ToolName::LinkMany) {
        return Err(DomainError::ResourceNotFound.into());
    }
    let single = name == ToolName::Link;
    if plans.is_empty() || plans.len() > 100 || (single && plans.len() != 1) {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let mut applied = BTreeMap::<Source, RevisionId>::new();
    let mut output = Vec::with_capacity(plans.len());
    for (index, item) in plans.iter().enumerate() {
        let plan = match item {
            ProposalLink::Ready(plan) => plan,
            ProposalLink::Rejected { error } if !single => {
                output.push(json!({"index": index, "ok": false, "error": error}));
                continue;
            }
            ProposalLink::Rejected { .. } => return Err(invalid(ValidationReason::InvalidState)),
        };
        let source = (plan.scope.clone(), plan.source.clone());
        let attempt = async {
            let scope = call.space(plan.scope.clone())?;
            proposal_class(authorize(call, &scope, plan).await?)?;
            let ordinal =
                u16::try_from(index).map_err(|_| invalid(ValidationReason::InvalidLimit))?;
            let identity = step_identity(ordinal, &plan.scope)?;
            let pinned = scope
                .clone()
                .with_confirmed_chat_step(witness.clone(), &identity)?;
            let mut mutation = plan.mutation(identity);
            mutation.preconditions.revision = Some(
                applied
                    .get(&source)
                    .or(plan.expected_revision.as_ref())
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?
                    .clone(),
            );
            let pinned = call.fence_confirmed_effect(pinned).await?;
            let persisted = call.registry.engine.link(pinned, mutation).await?;
            if persisted.value.source != plan.source {
                return Err(PortError::Unavailable(
                    OperationalFailure::new(
                        derive_digest("notarium.confirmed-link-receipt.v1", &[b"source_mismatch"]),
                        CommitEffect::Unknown,
                        RetryAdvice::RetrySameCommand,
                        true,
                    )
                    .expect("same-command retry has durable identity"),
                ));
            }
            // The committed note revision comes from the exact receipt event.
            // A fresh tip read could include an intervening manual edit and
            // accidentally authorize the next link on content never reviewed.
            exact_link_revision(call, &scope, &plan.source, &persisted.receipt)
                .await
                .map_err(post_commit_link_error)
        }
        .await;
        match attempt {
            Ok(revision) => {
                let mut result =
                    json!({"ok": true, "noteId": plan.source, "versionToken": revision});
                if single {
                    return Ok(result);
                }
                result["index"] = json!(index);
                output.push(result);
                applied.insert(source, revision);
            }
            Err(error) => {
                match super::super::super::note_tools::batch_operational_error(
                    "notarium.confirmed-link-receipt.v1",
                    error,
                    !applied.is_empty(),
                ) {
                    PortError::Domain(domain)
                        if !single && !matches!(domain, DomainError::RateLimited { .. }) =>
                    {
                        output.push(json!({"index": index, "ok": false, "error": domain.code()}));
                    }
                    other => return Err(other),
                }
            }
        }
    }
    Ok(json!({"results": output}))
}
