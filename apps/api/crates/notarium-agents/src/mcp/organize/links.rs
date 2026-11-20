mod proposal;

pub(in super::super) use proposal::{ProposalLink, apply_links, describe_links, plan_links};

use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{NoteId, RevisionId, SpaceId},
    model::{HistoryScope, Lifecycle},
    ports::{
        Committed, GetNote, Link, LinkBatch, LinkTarget, Mutation, NoteSnapshot, Preconditions,
        SpaceContext,
    },
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::{ToolCallContext, ToolName, corpus, decode, invalid};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in super::super) struct LinkArgs {
    pub relation: String,
    pub to: Option<String>,
    pub to_title: Option<String>,
}

#[derive(Deserialize)]
struct LinkInput {
    #[serde(rename = "from")]
    source: String,
    #[serde(flatten)]
    edge: LinkArgs,
}

#[derive(Deserialize)]
struct LinkManyInput {
    links: Vec<LinkInput>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(in super::super) struct LinkPlan {
    pub scope: HistoryScope,
    pub source: NoteId,
    pub expected_revision: Option<RevisionId>,
    relation: String,
    target: Target,
}

#[derive(Clone, Deserialize, Serialize)]
enum Target {
    Stable {
        note: NoteId,
        alias: Option<TargetAlias>,
    },
    Authored {
        name: String,
    },
}

#[derive(Clone, Deserialize, Serialize)]
struct TargetAlias {
    title: String,
    revision: RevisionId,
}

impl LinkPlan {
    pub(in super::super) fn mutation(&self, identity: CommandIdentity) -> Mutation<Link> {
        let (target, title) = self.target.link_parts();
        Mutation {
            identity,
            preconditions: Preconditions {
                revision: self.expected_revision.clone(),
                ..Preconditions::default()
            },
            input: Link {
                source: self.source.clone(),
                target,
                relation: self.relation.clone(),
                target_title: title,
            },
        }
    }
}

impl Target {
    fn link_parts(&self) -> (LinkTarget, Option<String>) {
        match self {
            Self::Stable { note, alias } => (
                LinkTarget::Note(note.clone()),
                alias.as_ref().map(|alias| alias.title.clone()),
            ),
            Self::Authored { name } => (LinkTarget::AuthoredName(name.clone()), None),
        }
    }
}

fn valid_title(value: &str) -> bool {
    !value.trim().is_empty()
        && !value.chars().any(char::is_control)
        && !value.contains(['[', ']', '|', '\\'])
}

fn authored_name(value: &str) -> Result<&str, PortError> {
    let value = value.trim();
    if !valid_title(value)
        || value.contains(['/', '#'])
        || matches!(value, "." | "..")
        || NoteId::parse(value).is_ok()
    {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    Ok(value)
}

pub(in super::super) fn format_link_line(
    relation: &str,
    target: &LinkTarget,
    label: Option<&str>,
) -> Result<String, PortError> {
    let relation = relation.trim();
    if relation.is_empty()
        || relation.chars().any(char::is_control)
        || relation.contains([':', '[', ']', '|', '\\'])
    {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    corpus::validate_field_key(relation)?;
    let (target, accepts_label) = match target {
        LinkTarget::Note(note) => (note.as_str(), true),
        LinkTarget::Folder(folder) => (folder.as_str(), false),
        LinkTarget::AuthoredName(name) => (authored_name(name)?, false),
    };
    match label {
        None => Ok(format!("- {relation}: [[{target}]]\n")),
        Some(label) if accepts_label && valid_title(label) => {
            Ok(format!("- {relation}: [[{target}|{}]]\n", label.trim()))
        }
        Some(_) => Err(invalid(ValidationReason::InvalidPathComponent)),
    }
}

async fn snapshot(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    note: &NoteId,
    revision: Option<RevisionId>,
    receipts: ReceiptSet,
) -> Result<NoteSnapshot, PortError> {
    let expected = revision.clone();
    let found = call
        .registry
        .engine
        .get_note(
            scope.clone(),
            GetNote {
                note: note.clone(),
                revision,
                causal: CausalBasis::Exact(receipts),
            },
        )
        .await?;
    if found.document.reference().space_id != scope.scope().space_id
        || found.document.reference().note_id != *note
        || expected
            .as_ref()
            .is_some_and(|rev| found.document.revision() != rev)
        || found.document.lifecycle() != Lifecycle::Active
        || found.document.class() == DocClass::EncryptedNote
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(found)
}

async fn resolve(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    to: Option<&str>,
    to_title: Option<&str>,
) -> Result<Target, PortError> {
    match (to, to_title) {
        (None, Some(name)) => Ok(Target::Authored {
            name: authored_name(name)?.to_owned(),
        }),
        (Some(id), None) => {
            let note = NoteId::parse(id)?;
            corpus::note_in_space(call, scope, &note).await?;
            let alias: Result<Option<TargetAlias>, PortError> = async {
                let current = snapshot(call, scope, &note, None, ReceiptSet::default()).await?;
                corpus::note_metadata_origin(call, scope, &current).await?;
                Ok(current
                    .provenance
                    .as_ref()
                    .filter(|data| valid_title(&data.title))
                    .map(|data| TargetAlias {
                        title: data.title.trim().to_owned(),
                        revision: current.document.revision().clone(),
                    }))
            }
            .await;
            let alias = match alias {
                Ok(alias) => alias,
                Err(error) if corpus::hidden(&error) => None,
                Err(error) => return Err(error),
            };
            Ok(Target::Stable { note, alias })
        }
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

pub(in super::super) async fn resolve_target(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    to: Option<&str>,
    to_title: Option<&str>,
) -> Result<(LinkTarget, Option<String>), PortError> {
    Ok(resolve(call, scope, to, to_title).await?.link_parts())
}

/// Normalize a link without writing. Confirmation can request a source revision
/// even when the live batch execution normally uses the canonical implicit base.
pub(in super::super) async fn plan_link(
    call: &ToolCallContext<'_>,
    source: NoteId,
    edge: &LinkArgs,
    observe_revision: bool,
) -> Result<LinkPlan, PortError> {
    let (scope, note) = corpus::locate_note(call, &source).await?;
    let target = resolve(call, &scope, edge.to.as_deref(), edge.to_title.as_deref()).await?;
    let (link_target, title) = target.link_parts();
    format_link_line(&edge.relation, &link_target, title.as_deref())?;
    let source_snapshot = if observe_revision || matches!(target, Target::Authored { .. }) {
        Some(
            snapshot(
                call,
                &scope,
                &note.reference.note_id,
                None,
                ReceiptSet::default(),
            )
            .await?,
        )
    } else {
        None
    };
    match &target {
        Target::Stable { note, .. } if note == &source => {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        Target::Authored { name } => {
            let parent = source_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.parent.clone());
            if call
                .registry
                .engine
                .resolve_note_target(scope.clone(), parent, name.clone())
                .await?
                .is_some_and(|found| {
                    found.space_id == scope.scope().space_id && found.note_id == source
                })
            {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
        }
        Target::Stable { .. } => (),
    }
    Ok(LinkPlan {
        scope: scope.scope().clone(),
        source,
        expected_revision: if observe_revision {
            source_snapshot
                .as_ref()
                .map(|snapshot| snapshot.document.revision().clone())
        } else {
            None
        },
        relation: edge.relation.trim().to_owned(),
        target,
    })
}

async fn authorize(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    plan: &LinkPlan,
) -> Result<DocClass, PortError> {
    let source = corpus::note_in_space(call, scope, &plan.source).await?;
    scope
        .auth()
        .authorize_direct_write(&source.facts, &source.facts)?;
    if let Target::Stable { note, alias } = &plan.target {
        corpus::note_in_space(call, scope, note).await?;
        if let Some(alias) = alias {
            let current = snapshot(
                call,
                scope,
                note,
                Some(alias.revision.clone()),
                ReceiptSet::default(),
            )
            .await?;
            let title = current
                .provenance
                .as_ref()
                .map(|metadata| metadata.title.trim());
            if title != Some(alias.title.as_str()) {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            corpus::note_metadata_origin(call, scope, &current).await?;
        }
    }
    Ok(source.facts.class)
}

async fn render(
    call: &mut ToolCallContext<'_>,
    scope: &SpaceContext,
    plan: &LinkPlan,
    committed: Committed<Link>,
) -> Result<Value, PortError> {
    scope.scope().check(committed.receipt.scope())?;
    if committed.value.source != plan.source {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let info: Result<Value, PortError> = async {
        let current = snapshot(
            call,
            scope,
            &plan.source,
            None,
            ReceiptSet::new([committed.receipt])?,
        )
        .await?;
        let (origin, project) = corpus::note_metadata_origin(call, scope, &current).await?;
        call.record_origin(origin, project)?;
        Ok(json!({"ok": true, "noteId": plan.source, "versionToken": current.document.revision()}))
    }
    .await;
    match info {
        Ok(result) => Ok(result),
        Err(error) => {
            tracing::debug!(code = error.code(), "link receipt metadata unavailable");
            Ok(json!({"ok": true}))
        }
    }
}

async fn single(call: &mut ToolCallContext<'_>, input: LinkInput) -> Result<Value, PortError> {
    let plan = call
        .journal("link-route", || async {
            let source = NoteId::parse(&input.source)?;
            plan_link(call, source, &input.edge, true).await
        })
        .await?;
    let scope = call.space(plan.scope.clone())?;
    authorize(call, &scope, &plan).await?;
    let identity = call.command_identity(&plan.scope, "link", 0);
    let committed = call
        .registry
        .engine
        .link(
            call.corpus_writer(scope.clone()).await?,
            plan.mutation(identity),
        )
        .await?;
    render(call, &scope, &plan, committed).await
}

struct Prepared {
    ordinal: u16,
    plan: LinkPlan,
}

async fn many(call: &mut ToolCallContext<'_>, inputs: Vec<LinkInput>) -> Result<Value, PortError> {
    let mut results = vec![None; inputs.len()];
    let mut batches = BTreeMap::<SpaceId, Vec<Prepared>>::new();
    for (index, input) in inputs.into_iter().enumerate() {
        let ordinal = u16::try_from(index).map_err(|_| invalid(ValidationReason::InvalidLimit))?;
        let label = format!("link-route-{ordinal}");
        let planned = async {
            let plan = call
                .journal(&label, || async {
                    let source = NoteId::parse(&input.source)?;
                    plan_link(call, source, &input.edge, false).await
                })
                .await?;
            let scope = call.space(plan.scope.clone())?;
            authorize(call, &scope, &plan).await?;
            Ok::<_, PortError>(plan)
        }
        .await;
        match planned {
            Ok(plan) => batches
                .entry(plan.scope.space_id.clone())
                .or_default()
                .push(Prepared { ordinal, plan }),
            Err(PortError::Domain(error)) => {
                results[index] = Some(json!({"index": index, "ok": false, "error": error.code()}));
            }
            Err(error) => return Err(error),
        }
    }
    for batch in batches.into_values() {
        let scope = call.space(batch[0].plan.scope.clone())?;
        let mut mutations = Vec::with_capacity(batch.len());
        for prepared in &batch {
            scope.scope().check(&prepared.plan.scope)?;
            let identity = call.command_identity(&prepared.plan.scope, "link", prepared.ordinal);
            mutations.push(prepared.plan.mutation(identity));
        }
        let response = call
            .registry
            .engine
            .link_many(
                call.corpus_writer(scope.clone()).await?,
                LinkBatch { items: mutations },
            )
            .await?;
        if response.items.len() != batch.len() {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        for (prepared, outcome) in batch.into_iter().zip(response.items) {
            let index = usize::from(prepared.ordinal);
            let mut value = match outcome {
                Ok(committed) => render(call, &scope, &prepared.plan, committed).await?,
                Err(error) => json!({"ok": false, "error": error.code()}),
            };
            value["index"] = json!(index);
            results[index] = Some(value);
        }
    }
    let results = results
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
    Ok(json!({ "results": results }))
}

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    match name {
        ToolName::Link => single(call, decode(args)?).await,
        ToolName::LinkMany => many(call, decode::<LinkManyInput>(args)?.links).await,
        _ => Err(DomainError::ResourceNotFound.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_keeps_valid_items_when_another_source_id_is_malformed() {
        let source = NoteId::from_bytes([1; 16]);
        let batch: LinkManyInput = decode(json!({
            "links": [
                {"from": "nt_bad", "relation": "related", "toTitle": "Later note"},
                {"from": source, "relation": "related", "toTitle": "Later note"}
            ],
        }))
        .unwrap();
        assert!(NoteId::parse(&batch.links[0].source).is_err());
        assert_eq!(NoteId::parse(&batch.links[1].source).unwrap(), source);
    }

    #[test]
    fn formats_stable_alias_and_title_only_targets() {
        let note = NoteId::from_bytes([1; 16]);
        assert_eq!(
            format_link_line("relates", &LinkTarget::Note(note.clone()), Some("Proof")).unwrap(),
            format!("- relates: [[{note}|Proof]]\n"),
        );
        assert_eq!(
            format_link_line(
                "relates",
                &LinkTarget::AuthoredName("A later note".into()),
                None
            )
            .unwrap(),
            "- relates: [[A later note]]\n",
        );
        for invalid in [
            note.to_string(),
            "abcdefghijkl".into(),
            "../Other".into(),
            "A\nB".into(),
        ] {
            assert!(authored_name(&invalid).is_err());
        }
    }
}
