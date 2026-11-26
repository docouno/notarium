mod proposal;

pub(in super::super) use proposal::{
    ProposalLink, apply_links, authorize_link_source_owner, describe_links, is_valid_link_item,
    plan_links, validate_link_proposal_input,
};

use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, NoteId, RevisionId, SpaceId},
    model::{HistoryScope, Lifecycle},
    ports::{
        Committed, GetNote, Link, LinkBatch, LinkTarget, Mutation, NoteMetadataSnapshot,
        Preconditions, SpaceContext,
    },
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::{ToolCallContext, ToolName, corpus, decode, derive_digest, invalid};

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

/// Content-free plan persisted in `control.mcp_dedup` for direct `link` and
/// `link_many` retries. User strings (`relation`, target titles) stay out of
/// the control journal and are re-bound via digests from the caller arguments
/// and canonical metadata on execution/replay.
#[derive(Clone, Deserialize, Serialize)]
struct JournaledLinkPlan {
    scope: HistoryScope,
    source: NoteId,
    expected_revision: Option<RevisionId>,
    target: JournaledTarget,
}

#[derive(Clone, Deserialize, Serialize)]
enum JournaledTarget {
    Stable {
        note: NoteId,
        alias_revision: Option<RevisionId>,
        alias_title_digest: Option<ContentDigest>,
    },
    Authored {
        name_digest: ContentDigest,
    },
}

fn title_digest(domain: &str, value: &str) -> ContentDigest {
    derive_digest(domain, &[value.as_bytes()])
}

impl LinkPlan {
    fn to_journaled(&self) -> JournaledLinkPlan {
        let target = match &self.target {
            Target::Stable { note, alias } => JournaledTarget::Stable {
                note: note.clone(),
                alias_revision: alias.as_ref().map(|alias| alias.revision.clone()),
                alias_title_digest: alias
                    .as_ref()
                    .map(|alias| title_digest("notarium.link.alias-title.v1", &alias.title)),
            },
            Target::Authored { name } => JournaledTarget::Authored {
                name_digest: title_digest("notarium.link.authored-title.v1", name),
            },
        };
        JournaledLinkPlan {
            scope: self.scope.clone(),
            source: self.source.clone(),
            expected_revision: self.expected_revision.clone(),
            target,
        }
    }

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

pub(in super::super) fn validate_link_args(edge: &LinkArgs) -> Result<(), PortError> {
    let relation = edge.relation.trim();
    if relation.is_empty()
        || relation.chars().any(char::is_control)
        || relation.contains([':', '[', ']', '|', '\\'])
    {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    corpus::validate_field_key(relation)?;
    match (edge.to.as_deref(), edge.to_title.as_deref()) {
        (Some(id), None) => {
            let _ = NoteId::parse(id)?;
            Ok(())
        }
        (None, Some(name)) => {
            let _ = authored_name(name)?;
            Ok(())
        }
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
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

async fn metadata_snapshot(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    note: &NoteId,
    revision: Option<RevisionId>,
    receipts: ReceiptSet,
    allow_trashed: bool,
) -> Result<NoteMetadataSnapshot, PortError> {
    let expected = revision.clone();
    let found = call
        .registry
        .engine
        .get_note_metadata(
            scope.clone(),
            GetNote {
                note: note.clone(),
                revision,
                causal: CausalBasis::Exact(receipts),
            },
        )
        .await?;
    let lifecycle_hidden = if allow_trashed {
        found.metadata.lifecycle() == Lifecycle::Purged
    } else {
        found.metadata.lifecycle() != Lifecycle::Active
    };
    if found.metadata.reference().space_id != scope.scope().space_id
        || found.metadata.reference().note_id != *note
        || expected
            .as_ref()
            .is_some_and(|rev| found.metadata.revision() != rev)
        || lifecycle_hidden
        || found.metadata.class() == DocClass::EncryptedNote
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(found)
}

async fn resolve(
    call: &ToolCallContext<'_>,
    provider: Option<&ToolCallContext<'_>>,
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
            let collapse = |error: PortError| {
                if corpus::hidden(&error) {
                    DomainError::ResourceNotFound.into()
                } else {
                    error
                }
            };
            let check = provider.unwrap_or(call);
            let check_scope = if provider.is_some() {
                check.space(scope.scope().clone()).map_err(collapse)?
            } else {
                scope.clone()
            };
            let target_note = corpus::note_in_space(check, &check_scope, &note)
                .await
                .map_err(collapse)?;
            corpus::admit_provider_note_read(check, &check_scope, &target_note)
                .await
                .map_err(collapse)?;
            if provider.is_some() {
                corpus::note_in_space(call, scope, &note).await?;
            }
            let current =
                metadata_snapshot(call, scope, &note, None, ReceiptSet::default(), false).await?;
            corpus::note_metadata_origin(check, &check_scope, &current.metadata)
                .await
                .map_err(collapse)?;
            let alias = current
                .provenance
                .as_ref()
                .filter(|data| valid_title(&data.title))
                .map(|data| TargetAlias {
                    title: data.title.trim().to_owned(),
                    revision: current.metadata.revision().clone(),
                });
            Ok(Target::Stable { note, alias })
        }
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

pub(in super::super) async fn resolve_target(
    call: &ToolCallContext<'_>,
    provider: Option<&ToolCallContext<'_>>,
    scope: &SpaceContext,
    to: Option<&str>,
    to_title: Option<&str>,
) -> Result<(LinkTarget, Option<String>), PortError> {
    Ok(resolve(call, provider, scope, to, to_title)
        .await?
        .link_parts())
}

pub(super) fn validate_single_link(source: &NoteId, edge: &LinkArgs) -> Result<(), PortError> {
    validate_link_args(edge)?;
    if let Some(to) = edge.to.as_deref()
        && NoteId::parse(to)? == *source
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}

/// Normalize a link without writing. Confirmation can request a source revision
/// even when the live batch execution normally uses the canonical implicit base.
pub(in super::super) async fn plan_link(
    call: &ToolCallContext<'_>,
    provider: Option<&ToolCallContext<'_>>,
    source: NoteId,
    edge: &LinkArgs,
    observe_revision: bool,
) -> Result<LinkPlan, PortError> {
    validate_single_link(&source, edge)?;
    let (scope, note) = if let Some(pin) = call.auth.pinned_write_space() {
        let scope = super::super::session::space(call, pin).await?;
        let note = corpus::note_in_space_preflight(call, &scope, &source).await?;
        (scope, note)
    } else {
        corpus::locate_note_preflight(call, &source).await?
    };
    plan_link_located(call, provider, scope, note, edge, observe_revision).await
}

async fn plan_link_located(
    call: &ToolCallContext<'_>,
    provider: Option<&ToolCallContext<'_>>,
    scope: SpaceContext,
    note: notarium_core::ports::CatalogNote,
    edge: &LinkArgs,
    observe_revision: bool,
) -> Result<LinkPlan, PortError> {
    let source = note.reference.note_id.clone();
    validate_single_link(&source, edge)?;
    corpus::admit_note_write(call, &scope, &note).await?;
    super::super::note_tools::authorize_note_write(&scope, &note.facts)?;
    let target = resolve(
        call,
        provider,
        &scope,
        edge.to.as_deref(),
        edge.to_title.as_deref(),
    )
    .await?;
    let (link_target, title) = target.link_parts();
    format_link_line(&edge.relation, &link_target, title.as_deref())?;
    let source_snapshot = if observe_revision || matches!(target, Target::Authored { .. }) {
        Some(
            metadata_snapshot(
                call,
                &scope,
                &note.reference.note_id,
                None,
                ReceiptSet::default(),
                false,
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
                .map(|snapshot| snapshot.metadata.revision().clone())
        } else {
            None
        },
        relation: edge.relation.trim().to_owned(),
        target,
    })
}

async fn authorize_trashed_replay_source(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    note: &NoteId,
) -> Result<DocClass, PortError> {
    if scope.auth().taint().is_tainted() {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    if scope
        .auth()
        .pinned_write_space()
        .is_some_and(|pin| pin != &scope.scope().space_id)
    {
        return Err(DomainError::SpaceReadOnly.into());
    }
    let observed = call
        .registry
        .engine
        .get_note_metadata(
            scope.with_preflight_taint(),
            GetNote {
                note: note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await?;
    if observed.metadata.reference().space_id != scope.scope().space_id
        || observed.metadata.reference().note_id != *note
        || observed.metadata.lifecycle() != Lifecycle::Trashed
        || observed.metadata.class() == DocClass::EncryptedNote
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    observed.metadata.listing(scope.auth())?;
    corpus::admit_note_metadata_write(call, scope, &observed.metadata).await?;
    super::super::note_tools::authorize_metadata_note_write(scope, &observed.metadata)?;
    Ok(observed.metadata.class())
}

async fn authorize(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    plan: &LinkPlan,
    allow_trashed_replay: bool,
) -> Result<DocClass, PortError> {
    let source_class = match corpus::note_in_space_preflight(call, scope, &plan.source).await {
        Ok(source) => {
            corpus::admit_note_write(call, scope, &source).await?;
            super::super::note_tools::authorize_note_write(scope, &source.facts)?;
            source.facts.class
        }
        Err(PortError::Domain(DomainError::ResourceNotFound)) if allow_trashed_replay => {
            authorize_trashed_replay_source(call, scope, &plan.source).await?
        }
        Err(error) => return Err(error),
    };
    if let Target::Stable { note, alias } = &plan.target {
        let mut target_trashed = false;
        match corpus::note_in_space(call, scope, note).await {
            Ok(target_note) => {
                corpus::admit_provider_note_read(call, scope, &target_note).await?;
            }
            Err(PortError::Domain(DomainError::ResourceNotFound)) if allow_trashed_replay => {
                let live = call
                    .registry
                    .engine
                    .get_note_metadata(
                        scope.clone(),
                        GetNote {
                            note: note.clone(),
                            revision: None,
                            causal: CausalBasis::Await(Default::default()),
                        },
                    )
                    .await?;
                if live.metadata.reference().space_id != scope.scope().space_id
                    || live.metadata.reference().note_id != *note
                    || live.metadata.lifecycle() != Lifecycle::Trashed
                    || live.metadata.class() == DocClass::EncryptedNote
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                live.metadata.listing(scope.auth())?;
                corpus::admit_note_metadata_write(call, scope, &live.metadata).await?;
                target_trashed = true;
            }
            Err(error) => return Err(error),
        }
        if let Some(alias) = alias {
            let current = metadata_snapshot(
                call,
                scope,
                note,
                Some(alias.revision.clone()),
                ReceiptSet::default(),
                allow_trashed_replay,
            )
            .await?;
            let title = current
                .provenance
                .as_ref()
                .map(|metadata| metadata.title.trim());
            if title != Some(alias.title.as_str()) {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            if target_trashed {
                current.metadata.listing(scope.auth())?;
                corpus::admit_note_metadata_write(call, scope, &current.metadata).await?;
            } else {
                corpus::note_metadata_origin(call, scope, &current.metadata).await?;
            }
        }
    }
    Ok(source_class)
}

async fn hydrate_journaled(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    journaled: JournaledLinkPlan,
    edge: &LinkArgs,
) -> Result<LinkPlan, PortError> {
    let relation = edge.relation.trim();
    if relation.is_empty() {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let target = match journaled.target {
        JournaledTarget::Authored { name_digest } => {
            let raw = edge
                .to_title
                .as_deref()
                .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
            let name = authored_name(raw)?;
            if title_digest("notarium.link.authored-title.v1", name) != name_digest {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            Target::Authored {
                name: name.to_owned(),
            }
        }
        JournaledTarget::Stable {
            note,
            alias_revision,
            alias_title_digest,
        } => {
            let raw_to = edge
                .to
                .as_deref()
                .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
            if NoteId::parse(raw_to)? != note {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            let alias = match (alias_revision, alias_title_digest) {
                (Some(revision), Some(expected_digest)) => {
                    let current = metadata_snapshot(
                        call,
                        scope,
                        &note,
                        Some(revision.clone()),
                        ReceiptSet::default(),
                        true,
                    )
                    .await?;
                    let title = current
                        .provenance
                        .as_ref()
                        .map(|metadata| metadata.title.trim())
                        .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
                    if title_digest("notarium.link.alias-title.v1", title) != expected_digest {
                        return Err(invalid(ValidationReason::SourceMismatch));
                    }
                    Some(TargetAlias {
                        title: title.to_owned(),
                        revision,
                    })
                }
                (None, None) => None,
                _ => return Err(invalid(ValidationReason::SourceMismatch)),
            };
            Target::Stable { note, alias }
        }
    };
    Ok(LinkPlan {
        scope: journaled.scope,
        source: journaled.source,
        expected_revision: journaled.expected_revision,
        relation: relation.to_owned(),
        target,
    })
}

async fn render(
    call: &mut ToolCallContext<'_>,
    scope: &SpaceContext,
    plan: &LinkPlan,
    committed: Committed<Link>,
) -> Result<Value, PortError> {
    const LABEL: &str = "notarium.mcp.link-receipt.v1";
    scope
        .scope()
        .check(committed.receipt.scope())
        .map_err(|error| super::super::note_tools::post_commit_error(LABEL, error.into()))?;
    if committed.value.source != plan.source {
        return Err(super::super::note_tools::post_commit_error(
            LABEL,
            invalid(ValidationReason::SourceMismatch),
        ));
    }
    // Resolve the exact revision produced by this link command rather than
    // reading the current tip, so an intervening manual edit's versionToken
    // is never returned to a caller holding stale note text.
    let exact_rev = proposal::exact_link_revision(call, scope, &plan.source, &committed.receipt)
        .await
        .map_err(|error| super::super::note_tools::post_commit_error(LABEL, error))?;
    if matches!(
        call.target,
        super::super::EgressTarget::InAppProvider { .. }
    ) {
        let admit: Result<(), PortError> = async {
            let current = metadata_snapshot(
                call,
                scope,
                &plan.source,
                Some(exact_rev.clone()),
                ReceiptSet::new([committed.receipt])?,
                true,
            )
            .await?;
            let (origin, project) =
                corpus::note_metadata_origin(call, scope, &current.metadata).await?;
            call.record_origin(origin, project)?;
            Ok(())
        }
        .await;
        if let Err(error) = admit {
            if corpus::hidden(&error) {
                tracing::debug!(code = error.code(), "link receipt metadata unavailable");
                return Ok(json!({"ok": true}));
            }
            return Err(super::super::note_tools::post_commit_error(LABEL, error));
        }
    }
    Ok(json!({"ok": true, "noteId": plan.source, "versionToken": exact_rev}))
}

async fn single(call: &mut ToolCallContext<'_>, input: LinkInput) -> Result<Value, PortError> {
    let mut replayed = true;
    let journaled: JournaledLinkPlan = call
        .journal("link-route", || async {
            replayed = false;
            let source = NoteId::parse(&input.source)?;
            let plan = plan_link(call, None, source, &input.edge, true).await?;
            Ok(plan.to_journaled())
        })
        .await?;
    let scope = call.space(journaled.scope.clone())?;
    let plan = hydrate_journaled(call, &scope, journaled, &input.edge).await?;
    authorize(call, &scope, &plan, replayed).await?;
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
            let mut replayed = true;
            let journaled: JournaledLinkPlan = call
                .journal(&label, || async {
                    replayed = false;
                    let source = NoteId::parse(&input.source)?;
                    let plan = plan_link(call, None, source, &input.edge, false).await?;
                    Ok(plan.to_journaled())
                })
                .await?;
            let scope = call.space(journaled.scope.clone())?;
            let plan = hydrate_journaled(call, &scope, journaled, &input.edge).await?;
            authorize(call, &scope, &plan, replayed).await?;
            Ok::<_, PortError>(plan)
        }
        .await;
        match planned {
            Ok(plan) => batches
                .entry(plan.scope.space_id.clone())
                .or_default()
                .push(Prepared { ordinal, plan }),
            Err(PortError::Domain(error)) if !matches!(error, DomainError::RateLimited { .. }) => {
                results[index] = Some(json!({"index": index, "ok": false, "error": error.code()}));
            }
            Err(error) => return Err(error),
        }
    }
    const LABEL: &str = "notarium.mcp.link-many-batch.v1";
    let mut committed_any = false;
    for batch in batches.into_values() {
        let prepared_batch = async {
            let scope = call.space(batch[0].plan.scope.clone())?;
            let mut mutations = Vec::with_capacity(batch.len());
            for prepared in &batch {
                scope.scope().check(&prepared.plan.scope)?;
                let identity =
                    call.command_identity(&prepared.plan.scope, "link", prepared.ordinal);
                mutations.push(prepared.plan.mutation(identity));
            }
            let writer = call.corpus_writer(scope.clone()).await?;
            let response = call
                .registry
                .engine
                .link_many(writer, LinkBatch { items: mutations })
                .await?;
            Ok::<_, PortError>((scope, response))
        }
        .await;
        let (scope, response) = match prepared_batch {
            Ok(pair) => pair,
            Err(error) => {
                match super::super::note_tools::batch_operational_error(LABEL, error, committed_any)
                {
                    PortError::Domain(error)
                        if !matches!(error, DomainError::RateLimited { .. }) =>
                    {
                        for prepared in batch {
                            let index = usize::from(prepared.ordinal);
                            results[index] = Some(json!({
                                "index": index,
                                "ok": false,
                                "error": error.code(),
                            }));
                        }
                        continue;
                    }
                    operational => return Err(operational),
                }
            }
        };
        if response.items.iter().any(Result::is_ok) {
            committed_any = true;
        }
        if response.items.len() != batch.len() {
            let err = invalid(ValidationReason::SourceMismatch);
            return Err(if committed_any {
                super::super::note_tools::post_commit_error(LABEL, err)
            } else {
                err
            });
        }
        for (prepared, outcome) in batch.into_iter().zip(response.items) {
            let index = usize::from(prepared.ordinal);
            let mut value = match outcome {
                Ok(committed) => render(call, &scope, &prepared.plan, committed)
                    .await
                    .map_err(|error| super::super::note_tools::post_commit_error(LABEL, error))?,
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

    #[test]
    fn journaled_link_plan_is_content_free() {
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([1; 16]),
            incarnation: notarium_core::ids::HistoryIncarnation::from_bytes([2; 16]),
        };
        let source = NoteId::from_bytes([3; 16]);
        let target = NoteId::from_bytes([4; 16]);
        let rev = RevisionId::from_bytes([5; 16]);

        let stable = LinkPlan {
            scope: scope.clone(),
            source: source.clone(),
            expected_revision: Some(rev.clone()),
            relation: "secret_relation".into(),
            target: Target::Stable {
                note: target,
                alias: Some(TargetAlias {
                    title: "Confidential Target Title".into(),
                    revision: rev,
                }),
            },
        };
        let encoded_stable = serde_json::to_string(&stable.to_journaled()).unwrap();
        assert!(!encoded_stable.contains("secret_relation"));
        assert!(!encoded_stable.contains("Confidential Target Title"));

        let authored = LinkPlan {
            scope,
            source,
            expected_revision: None,
            relation: "secret_relation".into(),
            target: Target::Authored {
                name: "Confidential Forward Title".into(),
            },
        };
        let encoded_authored = serde_json::to_string(&authored.to_journaled()).unwrap();
        assert!(!encoded_authored.contains("secret_relation"));
        assert!(!encoded_authored.contains("Confidential Forward Title"));
    }
}
