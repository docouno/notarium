//! Attested board mutation facts at a single canonical command boundary.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Weak},
};

use notarium_canonical::{
    CanonicalStore,
    codec::{encode_msgpack, evaluate_fields_with_schema, group_key_hex},
};
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, NoteId, RevisionId, SpaceSeq},
    model::Lifecycle,
    ports::{
        BoardGroupFieldKind, BoardMoveFacts, BoardMoveFactsSpec, BoardMutationFactsProvider,
        BoardPlannerAuthority, BoardViewRollbackFacts, EvaluatedBoardGroup, EvaluatedBoardRow,
        GroupKey, MoveBoardCard, PlannedNoteRestoration, PortFuture, RankExpectation,
        RollbackBoardFacts, RollbackBoardFactsRequest, SemanticPlacement, SpaceContext, ViewRef,
    },
    query::{FieldObservation, FieldSchema, FieldValue},
    value::YamlValue,
};
use notarium_syntax::extract::{ExtractedDocDelta, extract};

use crate::{
    nota::{NotaDescriptor, ViewKind, compile_projected_views},
    query::{
        compare_board_rows, compare_group_keys, group_key, sort_tuple, source_matches,
        view_authorization_folder,
    },
    runtime::{ProjectionEngine, records::effective_tags},
};

mod cut;

use cut::{BoardCut, BoardNote, PlannerDeadline};

/// Install the trusted planner without creating a cycle between the engine and
/// the canonical store. This is a single-registration composition operation.
pub(crate) fn register_board_provider(
    engine: &Arc<ProjectionEngine>,
) -> Result<BoardProviderRegistration, PortError> {
    let canonical = engine.canonical().clone();
    let authority = canonical
        .register_board_facts_provider(Arc::new(ProjectionBoardPlanner(Arc::downgrade(engine))))?;
    Ok(BoardProviderRegistration {
        canonical,
        authority,
    })
}

pub(crate) struct BoardProviderRegistration {
    canonical: CanonicalStore,
    authority: BoardPlannerAuthority,
}

impl Drop for BoardProviderRegistration {
    fn drop(&mut self) {
        self.canonical
            .unregister_board_facts_provider(&self.authority);
    }
}

struct ProjectionBoardPlanner(Weak<ProjectionEngine>);

impl BoardMutationFactsProvider for ProjectionBoardPlanner {
    fn evaluate_move<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        cutoff: Option<SpaceSeq>,
        intent: MoveBoardCard,
    ) -> PortFuture<'a, BoardMoveFacts> {
        Box::pin(async move {
            let engine = self.engine()?;
            let deadline = PlannerDeadline::start(&ctx);
            let cut = BoardCut::load(
                &engine,
                &ctx,
                cutoff,
                [&intent.view],
                [&intent.note],
                &deadline,
            )
            .await?;
            let (spec, auth_folder) = evaluate_move(&cut, &ctx, &intent, &deadline)?;
            let _permit = cut.check_live(
                &engine,
                &ctx,
                cutoff,
                [(&spec.view, spec.groups.as_slice())],
                std::iter::once(&intent.note),
                auth_folder.iter(),
                std::iter::empty(),
                &deadline,
            )?;
            Ok(BoardMoveFacts::attest(authority, spec))
        })
    }

    fn evaluate_rollback<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        request: RollbackBoardFactsRequest,
    ) -> PortFuture<'a, RollbackBoardFacts> {
        Box::pin(async move {
            let engine = self.engine()?;
            let deadline = PlannerDeadline::start(&ctx);
            let cut = BoardCut::load(
                &engine,
                &ctx,
                request.cutoff,
                request.views.iter(),
                request.eligible_notes.iter().map(|note| &note.note),
                &deadline,
            )
            .await?;
            let (views, auth_folders) = evaluate_rollback(&cut, &ctx, &request, &deadline)?;
            let _permit = cut.check_live(
                &engine,
                &ctx,
                request.cutoff,
                views
                    .iter()
                    .map(|(view, facts)| (view, facts.groups.as_slice())),
                std::iter::empty(),
                auth_folders.iter(),
                request.eligible_notes.iter(),
                &deadline,
            )?;
            Ok(RollbackBoardFacts::attest(
                authority, cut.scope, cut.cutoff, views,
            ))
        })
    }
}

impl ProjectionBoardPlanner {
    fn engine(&self) -> Result<Arc<ProjectionEngine>, PortError> {
        self.0
            .upgrade()
            .ok_or_else(|| DomainError::validation(ValidationReason::NotReady).into())
    }
}

fn evaluate_move(
    cut: &BoardCut,
    ctx: &SpaceContext,
    intent: &MoveBoardCard,
    deadline: &PlannerDeadline,
) -> Result<(BoardMoveFactsSpec, Option<FolderId>), PortError> {
    let plan = board_plan(cut, ctx, &intent.view)?;
    let auth_folder =
        view_authorization_folder(&plan.descriptor.source, plan.source_folder.as_ref()).cloned();
    let target = cut.active_note(ctx, &intent.note)?;
    let mut groups = plan.groups(cut, ctx, &intent.view, deadline)?;
    if !groups.iter().any(|group| group.group == intent.group) {
        groups.push(EvaluatedBoardGroup {
            group: intent.group.clone(),
            rows: Vec::new(),
        });
        groups.sort_by(|left, right| {
            compare_group_keys(&plan.descriptor.columns, &left.group, &right.group)
        });
    }
    let edited_raw = proposed_raw_fields(target, &intent.fields)?;
    let fields_after_move = edited_raw
        .as_ref()
        .map(|raw| evaluate_fields_with_schema(Some(raw), None, Some(plan.fields)));
    let edited_tags = edited_raw.as_ref().map(|raw| {
        effective_tags(&target.inline_tags, Some(raw))
            .into_iter()
            .collect::<BTreeSet<_>>()
    });
    let after_eligible_in_group = plan
        .group(
            cut,
            &target.parent_folder,
            target.class,
            edited_tags.as_ref().unwrap_or(&target.tags),
            fields_after_move.as_ref().unwrap_or(&target.fields),
        )?
        .is_some_and(|group| group == intent.group);

    let before_placement = semantic_placement(&groups, &intent.note);
    let base_order = sort_tuple(
        &plan.descriptor.sort,
        &intent.note,
        target.updated_at,
        &target.fields,
    );
    let base_order_binding = binding(
        b"notarium-board-order-v1:",
        &(
            &intent.view,
            &plan.view_revision,
            &plan.descriptor.sort,
            base_order,
        ),
        &groups,
    )?;
    Ok((
        BoardMoveFactsSpec {
            scope: cut.scope.clone(),
            cutoff: cut.cutoff,
            view: intent.view.clone(),
            view_revision: plan.view_revision,
            schema_revision: cut.schema_revision(),
            descriptor_fingerprint: cut.schema_fingerprint(),
            group_field: plan.group_field,
            group_field_kind: plan.group_field_kind,
            groups,
            before_placement,
            base_order_binding,
            after_eligible_in_group,
        },
        auth_folder,
    ))
}

fn evaluate_rollback(
    cut: &BoardCut,
    ctx: &SpaceContext,
    request: &RollbackBoardFactsRequest,
    deadline: &PlannerDeadline,
) -> Result<
    (
        BTreeMap<ViewRef, BoardViewRollbackFacts>,
        BTreeSet<FolderId>,
    ),
    PortError,
> {
    let mut views = BTreeMap::new();
    let mut auth_folders = BTreeSet::new();
    for view in &request.views {
        deadline.check()?;
        let plan = board_plan(cut, ctx, view)?;
        if let Some(folder) =
            view_authorization_folder(&plan.descriptor.source, plan.source_folder.as_ref())
        {
            auth_folders.insert(folder.clone());
        }
        let groups = plan.groups(cut, ctx, view, deadline)?;
        let mut post_restore_membership = BTreeMap::new();
        for restoration in &request.eligible_notes {
            deadline.check()?;
            let membership = restored_membership(cut, ctx, &plan, restoration)?;
            post_restore_membership.insert(restoration.note.clone(), membership);
        }
        views.insert(
            view.clone(),
            BoardViewRollbackFacts {
                view: view.clone(),
                view_revision: plan.view_revision,
                schema_revision: cut.schema_revision(),
                descriptor_fingerprint: cut.schema_fingerprint(),
                group_field: plan.group_field,
                group_field_kind: plan.group_field_kind,
                groups,
                post_restore_membership,
            },
        );
    }
    Ok((views, auth_folders))
}

struct BoardPlan<'a> {
    view_revision: RevisionId,
    descriptor: NotaDescriptor,
    group_field: String,
    group_field_kind: BoardGroupFieldKind,
    fields: &'a BTreeMap<String, FieldSchema>,
    source_folder: Option<FolderId>,
}

fn board_plan<'a>(
    cut: &'a BoardCut,
    ctx: &SpaceContext,
    view: &ViewRef,
) -> Result<BoardPlan<'a>, PortError> {
    let note = cut.active_note(ctx, &view.note)?;
    let fields = cut.schema_fields();
    let compiled = compile_projected_views(&note.views, fields);
    let descriptor = compiled.get(&view.key)?;
    if descriptor.kind != ViewKind::Board {
        return Err(DomainError::validation(ValidationReason::InvalidView).into());
    }
    let group_field = descriptor
        .group_by
        .clone()
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidView))?;
    let source_folder = cut.resolve_source(&descriptor.source, &note.parent_folder)?;
    cut.authorize_entry(
        ctx,
        view_authorization_folder(&descriptor.source, source_folder.as_ref()),
    )?;
    // Statically authorize the board's declared source scope (classes and
    // project boundary) before evaluating any note filters so a constrained
    // actor cannot probe unauthorized notes as an existence/filter oracle.
    cut.authorize_board_source(ctx, &descriptor.source, source_folder.as_ref())?;
    Ok(BoardPlan {
        view_revision: note.revision.clone(),
        descriptor: descriptor.clone(),
        group_field,
        group_field_kind: descriptor.board_group_kind(fields)?,
        fields,
        source_folder,
    })
}

impl BoardPlan<'_> {
    fn group(
        &self,
        cut: &BoardCut,
        parent: &FolderId,
        class: DocClass,
        tags: &BTreeSet<String>,
        fields: &BTreeMap<String, FieldObservation<FieldValue>>,
    ) -> Result<Option<GroupKey>, PortError> {
        if class == DocClass::EncryptedNote || !self.descriptor.filter.predicate.matches(fields) {
            return Ok(None);
        }
        let folder = cut.ancestry(parent)?;
        if !folder.active
            || !source_matches(
                &self.descriptor.source,
                self.source_folder.as_ref(),
                parent,
                &folder.ids,
                class,
                tags,
            )
        {
            return Ok(None);
        }
        Ok(Some(group_key(fields.get(&self.group_field))))
    }

    fn groups(
        &self,
        cut: &BoardCut,
        ctx: &SpaceContext,
        view: &ViewRef,
        deadline: &PlannerDeadline,
    ) -> Result<Vec<EvaluatedBoardGroup>, PortError> {
        let mut rows = Vec::new();
        for (id, note) in &cut.notes {
            deadline.check()?;
            if note.lifecycle != Lifecycle::Active {
                continue;
            }
            let Some(group) = self.group(
                cut,
                &note.parent_folder,
                note.class,
                &note.tags,
                &note.fields,
            )?
            else {
                continue;
            };
            // Board mutation facts can reach the live collaboration interceptor.
            // Filtering inaccessible rows would change placement and expose their
            // existence through the command. Refuse the whole plan instead.
            cut.authorize_note(ctx, note)?;
            let (_, group_hex) = group_key_hex(&group)?;
            let overlay = cut.ranks.get(view).and_then(|ranks| ranks.get(id));
            let expected_rank = overlay.map_or(RankExpectation::Absent, |rank| {
                RankExpectation::Existing(rank.revision.clone())
            });
            let rank = overlay
                .filter(|rank| rank.group_hex == group_hex)
                .map(|rank| rank.rank.as_str());
            let order = sort_tuple(&self.descriptor.sort, id, note.updated_at, &note.fields);
            let base_order_binding = binding(
                b"notarium-board-base-row-v1:",
                &(&self.descriptor.sort, &order),
                &[],
            )?;
            rows.push((
                group,
                rank,
                order,
                EvaluatedBoardRow {
                    note: id.clone(),
                    expected_note: note.revision.clone(),
                    expected_rank,
                    base_order_binding,
                },
            ));
        }
        rows.sort_by(|left, right| {
            compare_group_keys(&self.descriptor.columns, &left.0, &right.0).then_with(|| {
                compare_board_rows(&self.descriptor.sort, left.1, &left.2, right.1, &right.2)
                    .expect("sort tuples are produced by the same validated descriptor")
            })
        });
        deadline.check()?;

        let mut groups: Vec<EvaluatedBoardGroup> = Vec::new();
        for (group, _, _, row) in rows {
            if let Some(previous) = groups.last_mut()
                && previous.group == group
            {
                previous.rows.push(row);
            } else {
                groups.push(EvaluatedBoardGroup {
                    group,
                    rows: vec![row],
                });
            }
        }
        for group in &self.descriptor.columns {
            if !groups.iter().any(|present| present.group == *group) {
                groups.push(EvaluatedBoardGroup {
                    group: group.clone(),
                    rows: Vec::new(),
                });
            }
        }
        groups.sort_by(|left, right| {
            compare_group_keys(&self.descriptor.columns, &left.group, &right.group)
        });
        Ok(groups)
    }
}

fn proposed_raw_fields(
    note: &BoardNote,
    edits: &BTreeMap<String, Option<YamlValue>>,
) -> Result<Option<BTreeMap<String, YamlValue>>, PortError> {
    if edits.is_empty() {
        return Ok(None);
    }
    let mut raw = note
        .raw_fields
        .clone()
        .ok_or_else(|| DomainError::validation(ValidationReason::FmNotWritable))?;
    for (key, value) in edits {
        match value {
            Some(value) => {
                raw.insert(key.clone(), value.clone());
            }
            None => {
                raw.remove(key);
            }
        }
    }
    Ok(Some(raw))
}

fn restored_membership(
    cut: &BoardCut,
    ctx: &SpaceContext,
    plan: &BoardPlan<'_>,
    restoration: &PlannedNoteRestoration,
) -> Result<Option<GroupKey>, PortError> {
    if restoration.planned_lifecycle != Lifecycle::Active
        || restoration.planned_class == DocClass::EncryptedNote
        || !cut.ancestry(&restoration.planned_parent_folder)?.active
    {
        return Ok(None);
    }
    let current = cut
        .notes
        .get(&restoration.note)
        .ok_or(DomainError::ResourceNotFound)?;
    if current.revision != restoration.current_revision {
        return Err(DomainError::validation(ValidationReason::CursorStale).into());
    }
    let inline_tags = if let Some(carrier) = restoration
        .planned_carrier
        .as_deref()
        .filter(|_| !plan.descriptor.source.tags.is_empty())
    {
        match extract(
            carrier,
            restoration.planned_class,
            &restoration.note,
            "",
            None,
        )? {
            ExtractedDocDelta::Plain(doc) => doc.tags.into_iter().map(|tag| tag.key).collect(),
            ExtractedDocDelta::Encrypted(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };
    let raw: BTreeMap<_, _> = restoration
        .planned_fields
        .iter()
        .filter_map(|(key, value)| value.as_ref().map(|value| (key.clone(), value.clone())))
        .collect();
    let raw = (!raw.is_empty() || restoration.planned_header_diagnostic.is_none()).then_some(&raw);
    let tags = effective_tags(&inline_tags, raw).into_iter().collect();
    let fields = evaluate_fields_with_schema(
        raw,
        restoration.planned_header_diagnostic.as_ref(),
        Some(plan.fields),
    );
    let group = plan.group(
        cut,
        &restoration.planned_parent_folder,
        restoration.planned_class,
        &tags,
        &fields,
    )?;
    if group.is_some() {
        cut.authorize_placement(
            ctx,
            &restoration.planned_parent_folder,
            restoration.planned_class,
            restoration.planned_ability.clone(),
        )?;
    }
    Ok(group)
}

fn semantic_placement(groups: &[EvaluatedBoardGroup], target: &NoteId) -> SemanticPlacement {
    for group in groups {
        if let Some(index) = group.rows.iter().position(|row| row.note == *target) {
            return SemanticPlacement::InGroup {
                group: group.group.clone(),
                predecessor: index
                    .checked_sub(1)
                    .map(|prev| group.rows[prev].note.clone()),
                successor: group.rows.get(index + 1).map(|next| next.note.clone()),
            };
        }
    }
    SemanticPlacement::OutsideView
}

fn binding(
    domain: &[u8],
    value: &impl serde::Serialize,
    groups: &[EvaluatedBoardGroup],
) -> Result<ContentDigest, PortError> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(domain);
    hasher.update(&encode_msgpack(value)?);
    hasher.update(&(groups.len() as u64).to_le_bytes());
    for group in groups {
        hasher.update(&encode_msgpack(&group.group)?);
        hasher.update(&(group.rows.len() as u64).to_le_bytes());
        for row in &group.rows {
            hasher.update(row.base_order_binding.as_bytes());
            hasher.update(&encode_msgpack(&(&row.expected_note, &row.expected_rank))?);
        }
    }
    Ok(ContentDigest::from_bytes(*hasher.finalize().as_bytes()))
}
