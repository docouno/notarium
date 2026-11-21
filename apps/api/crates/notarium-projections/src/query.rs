//! Structural query planning over one retained projection cut.

use std::{
    cell::Cell,
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, btree_map::Entry},
};

use croaring::Bitmap;
use notarium_canonical::codec::{encode_msgpack, group_key_hex, internal_not_committed};
use notarium_core::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, Space, SpaceGrant, SpaceLifecycle},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, NoteId, RevisionId, SpaceSeq},
    model::{HistoryScope, LifecycleMask},
    ports::{GroupCount, GroupKey, NoteQuery, PageLimit, ViewQuery, ViewRef},
    query::{
        Direction, FieldObservation, FieldSchema, FieldValue, Predicate, SortCell, SortColumn,
        SortSpec, SortTuple,
    },
    value::{ExactNumber, ScalarValue, Timestamp},
};

use notarium_syntax::unicode::lookup_key;

use crate::{
    derived::{DerivedStore, GroupRankRange, ProjectedNote, ProjectedQueryRow},
    index::{IndexView, PostingKey},
    nota::{NotaDescriptor, SourceFolder, SourceScope, ViewKind, ViewSource},
};

pub type FieldObservations = BTreeMap<String, FieldObservation<FieldValue>>;

#[derive(Clone, Debug)]
pub struct ViewPlan {
    pub filter: Predicate,
    pub sort: SortSpec,
    pub group_by: Option<String>,
    pub fingerprint: ContentDigest,
}

pub fn plan_view(
    descriptor: &NotaDescriptor,
    request: &ViewQuery,
    revision: &RevisionId,
    schema_revision: Option<&RevisionId>,
    schema: &BTreeMap<String, FieldSchema>,
) -> DomainResult<ViewPlan> {
    descriptor.filter.validate_declared(schema)?;
    request.filter.validate_declared(schema)?;
    if descriptor.kind == ViewKind::Board
        && (request
            .group_by
            .as_ref()
            .is_some_and(|group| Some(group) != descriptor.group_by.as_ref())
            || request
                .sort
                .as_ref()
                .is_some_and(|sort| sort != &descriptor.sort))
    {
        return Err(invalid_query());
    }
    let sort = request
        .sort
        .clone()
        .unwrap_or_else(|| descriptor.sort.clone());
    check_sort_schema(&sort, schema)?;
    let group_by = request
        .group_by
        .clone()
        .or_else(|| descriptor.group_by.clone());
    if group_by
        .as_ref()
        .is_some_and(|group| group.is_empty() || group == "__proto__")
    {
        return Err(invalid_query());
    }
    let filter = Predicate::All(vec![
        descriptor.filter.predicate.clone(),
        request.filter.predicate.clone(),
    ]);
    let fingerprint = fingerprint(
        b"notarium-view-query-v1",
        &(
            &request.view,
            revision,
            schema_revision,
            descriptor.kind,
            &descriptor.source,
            &filter,
            &sort,
            &group_by,
        ),
    )?;
    Ok(ViewPlan {
        filter,
        sort,
        group_by,
        fingerprint,
    })
}

pub fn plan_notes(
    query: &NoteQuery,
    schema_revision: Option<&RevisionId>,
    schema: &BTreeMap<String, FieldSchema>,
) -> DomainResult<ContentDigest> {
    query.filter.validate_declared(schema)?;
    check_sort_schema(&query.sort, schema)?;
    let lifecycle = match query.lifecycle {
        LifecycleMask::Active => 0_u8,
        LifecycleMask::Trashed => 1_u8,
        LifecycleMask::ActiveAndTrashed => 2_u8,
    };
    fingerprint(
        b"notarium-note-query-v1",
        &(
            &query.folder,
            query.recursive,
            &query.classes,
            lifecycle,
            &query.filter,
            &query.sort,
            schema_revision,
        ),
    )
}

fn fingerprint<T: serde::Serialize>(domain: &[u8], input: &T) -> DomainResult<ContentDigest> {
    let encoded = encode_msgpack(input).map_err(|_| invalid_query())?;
    let mut hash = blake3::Hasher::new();
    hash.update(domain);
    hash.update(&encoded);
    Ok(ContentDigest::from_bytes(*hash.finalize().as_bytes()))
}

fn check_sort_schema(sort: &SortSpec, schema: &BTreeMap<String, FieldSchema>) -> DomainResult<()> {
    for key in sort.keys() {
        if let SortColumn::Field { key, schema: field } = &key.column {
            if key.is_empty() || key == "__proto__" {
                return Err(invalid_query());
            }
            if schema.get(key).is_some_and(|expected| expected != field) {
                return Err(DomainError::validation(
                    ValidationReason::UnsupportedSortType,
                ));
            }
        }
    }
    Ok(())
}

fn invalid_query() -> DomainError {
    DomainError::validation(ValidationReason::InvalidQuery)
}

fn stale_cut() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

fn index_failure(error: impl std::fmt::Display) -> PortError {
    internal_not_committed("projection_index_query", error.to_string())
}

pub fn entry_folder<'a>(
    grant: &'a SpaceGrant,
    root: &'a FolderId,
    requested: Option<&'a FolderId>,
) -> &'a FolderId {
    requested.or(grant.project_root.as_ref()).unwrap_or(root)
}

/// Use only after checking the entry folder against the current authoritative
/// view. For old cuts the caller also intersects current per-row visibility.
pub fn structural_universe(
    index: &IndexView,
    space: &Space,
    auth: &EngineAuthContext,
) -> Result<Bitmap, PortError> {
    let mut visible = note_universe(index, space, auth, LifecycleMask::Active)?;
    index
        .andnot_posting_inplace(&mut visible, &PostingKey::Encrypted)
        .map_err(index_failure)?;
    Ok(visible)
}

pub fn note_universe(
    index: &IndexView,
    space: &Space,
    auth: &EngineAuthContext,
    lifecycle: LifecycleMask,
) -> Result<Bitmap, PortError> {
    if space.lifecycle != SpaceLifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let grant = auth
        .spaces()
        .get(&space.id)
        .ok_or(DomainError::ResourceNotFound)?;
    let classes = class_union(index, &grant.read_classes)?;
    let mut visible = match &grant.project_root {
        None => classes,
        Some(folder) => {
            let mut visible = folder_notes(index, folder, true)?;
            if grant.read_classes.contains(&DocClass::Skill) {
                for ability in auth.readonly_abilities() {
                    visible.or_inplace(&posting(index, &PostingKey::Ability(ability.clone()))?);
                }
            }
            visible.and_inplace(&classes);
            visible
        }
    };
    match lifecycle {
        LifecycleMask::Active => {
            index
                .and_posting_inplace(&mut visible, &PostingKey::Active)
                .map_err(index_failure)?;
            index
                .andnot_posting_inplace(&mut visible, &PostingKey::TrashedSubtree)
                .map_err(index_failure)?;
        }
        LifecycleMask::Trashed => {
            let mut active = posting(index, &PostingKey::Active)?;
            index
                .and_posting_inplace(&mut active, &PostingKey::TrashedSubtree)
                .map_err(index_failure)?;
            active.or_inplace(&posting(index, &PostingKey::Trashed)?);
            visible.and_inplace(&active);
        }
        LifecycleMask::ActiveAndTrashed => {
            let mut active = posting(index, &PostingKey::Active)?;
            active.or_inplace(&posting(index, &PostingKey::Trashed)?);
            visible.and_inplace(&active);
        }
    }
    Ok(visible)
}

pub fn view_source_candidates(
    index: &IndexView,
    source: &ViewSource,
    folder: Option<&FolderId>,
    mut universe: Bitmap,
) -> Result<Bitmap, PortError> {
    universe.and_inplace(&class_union(index, &source.classes)?);
    index
        .andnot_posting_inplace(&mut universe, &PostingKey::Encrypted)
        .map_err(index_failure)?;
    if let Some(folder) = folder {
        universe.and_inplace(&folder_notes(index, folder, source.recursive)?);
    }
    for tag in &source.tags {
        if universe.is_empty() {
            break;
        }
        if index.tags_bucketed() {
            let hits = index
                .tag_candidates(tag, &universe)
                .map_err(index_failure)?;
            universe = hits.into_possible();
        } else {
            index
                .and_posting_inplace(&mut universe, &PostingKey::Tag(tag.clone()))
                .map_err(index_failure)?;
        }
    }
    Ok(universe)
}

pub fn note_source_candidates(
    index: &IndexView,
    query: &NoteQuery,
    entry: &FolderId,
    mut universe: Bitmap,
) -> Result<Bitmap, PortError> {
    universe.and_inplace(&class_union(index, &query.classes)?);
    if let Some(folder) = &query.folder {
        universe.and_inplace(&folder_notes(index, folder, query.recursive)?);
    } else if !query.recursive {
        universe.and_inplace(&folder_notes(index, entry, false)?);
    }
    Ok(universe)
}

pub fn source_matches(
    source: &ViewSource,
    folder: Option<&FolderId>,
    parent: &FolderId,
    ancestors: &[FolderId],
    class: DocClass,
    tags: &BTreeSet<String>,
) -> bool {
    class != DocClass::EncryptedNote
        && source.classes.contains(&class)
        && source.tags.is_subset(tags)
        && folder.is_none_or(|folder| {
            folder == parent || (source.recursive && ancestors.contains(folder))
        })
}

/// A project source begins at the enclosing project of the defining note.
/// Explicit paths are relative to the Space root at the retained cut.
pub fn resolve_source_folder(
    source: &ViewSource,
    root: &FolderId,
    view_project: Option<&FolderId>,
    by_path: impl FnOnce(&str) -> Option<FolderId>,
) -> DomainResult<Option<FolderId>> {
    match &source.folder {
        Some(SourceFolder::Id(folder)) => Ok(Some(folder.clone())),
        Some(SourceFolder::Path(path)) if path == "/" => Ok(Some(root.clone())),
        Some(SourceFolder::Path(path)) => {
            let normalized = normalized_source_path(path);
            // Canonical v1 IDs were parsed by the compiler. Legacy spellings
            // may be ordinary path names, so resolve the path first.
            by_path(&normalized)
                .or_else(|| FolderId::parse(path).ok())
                .map(Some)
                .ok_or(DomainError::ResourceNotFound)
        }
        None => match source.scope {
            SourceScope::Space if source.recursive => Ok(None),
            SourceScope::Space => Ok(Some(root.clone())),
            SourceScope::Project => view_project
                .cloned()
                .map(Some)
                .ok_or(DomainError::ResourceNotFound),
            SourceScope::Folder => Err(DomainError::ResourceNotFound),
        },
    }
}

/// The resolved folder narrows the candidates. An unqualified Space source
/// enters through the caller's grant even when its filter selects root children.
pub(crate) fn view_authorization_folder<'a>(
    source: &ViewSource,
    resolved: Option<&'a FolderId>,
) -> Option<&'a FolderId> {
    if source.scope == SourceScope::Space && source.folder.is_none() {
        None
    } else {
        resolved
    }
}

pub fn normalized_source_path(path: &str) -> String {
    path.trim_start_matches('/')
        .split('/')
        .map(lookup_key)
        .collect::<Vec<_>>()
        .join("/")
}

fn class_union(index: &IndexView, classes: &BTreeSet<DocClass>) -> Result<Bitmap, PortError> {
    let mut result = Bitmap::new();
    for class in classes {
        result.or_inplace(&posting(index, &PostingKey::DocClass(*class))?);
    }
    Ok(result)
}

fn folder_notes(
    index: &IndexView,
    folder: &FolderId,
    recursive: bool,
) -> Result<Bitmap, PortError> {
    let Some(folder) = index.dense_folder_id(folder) else {
        return Ok(Bitmap::new());
    };
    let key = if recursive {
        PostingKey::FolderSubtree(folder)
    } else {
        PostingKey::FolderDirect(folder)
    };
    posting(index, &key)
}

fn posting(index: &IndexView, key: &PostingKey) -> Result<Bitmap, PortError> {
    index.posting(key).map_err(index_failure)
}

pub fn group_key(field: Option<&FieldObservation<FieldValue>>) -> GroupKey {
    match field {
        None | Some(FieldObservation::Absent) => GroupKey::Absent,
        Some(FieldObservation::Ok(FieldValue::Scalar(value))) => GroupKey::Value(value.clone()),
        Some(FieldObservation::Ok(FieldValue::List(values))) if values.is_empty() => {
            GroupKey::EmptyList
        }
        Some(FieldObservation::Ok(_) | FieldObservation::Bad { .. }) => GroupKey::Bad,
    }
}

fn scalar_type_rank(value: &ScalarValue) -> u8 {
    match value {
        ScalarValue::Null => 0,
        ScalarValue::String(_) => 1,
        ScalarValue::Bool(_) => 2,
        ScalarValue::Number(_) => 3,
        ScalarValue::Date(_) => 4,
        ScalarValue::Timestamp(_) => 5,
    }
}

fn compare_scalar(left: &ScalarValue, right: &ScalarValue) -> Ordering {
    scalar_type_rank(left)
        .cmp(&scalar_type_rank(right))
        .then_with(|| {
            // Equal type tags are the precondition of compare_same_type.
            left.compare_same_type(right).expect("scalar types match")
        })
}

fn group_category(columns: &[GroupKey], group: &GroupKey) -> (u64, Option<usize>) {
    if let Some(declared) = columns.iter().position(|value| value == group) {
        return (0, Some(declared));
    }
    let category = match group {
        GroupKey::Value(_) => 1,
        GroupKey::EmptyList => 2,
        GroupKey::Bad => 3,
        GroupKey::Absent => 4,
    };
    (category, None)
}

pub fn compare_group_keys(columns: &[GroupKey], left: &GroupKey, right: &GroupKey) -> Ordering {
    let left_category = group_category(columns, left);
    let right_category = group_category(columns, right);
    left_category
        .cmp(&right_category)
        .then_with(|| match (left_category.0, left, right) {
            (1, GroupKey::Value(left), GroupKey::Value(right)) => compare_scalar(left, right),
            _ => Ordering::Equal,
        })
}

pub fn sort_tuple(
    sort: &SortSpec,
    note: &NoteId,
    updated: Timestamp,
    fields: &FieldObservations,
) -> SortTuple {
    SortTuple {
        entity_id: note.clone(),
        cells: sort_cells(sort, updated, fields),
    }
}

fn sort_cells(sort: &SortSpec, updated: Timestamp, fields: &FieldObservations) -> Vec<SortCell> {
    sort.keys()
        .iter()
        .map(|key| match &key.column {
            SortColumn::UpdatedAt => SortCell::Value(ScalarValue::Timestamp(updated)),
            SortColumn::Field { key, .. } => match fields.get(key) {
                None | Some(FieldObservation::Absent) => SortCell::Absent,
                Some(FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Null))) => SortCell::Null,
                Some(FieldObservation::Ok(FieldValue::Scalar(value))) => {
                    SortCell::Value(value.clone())
                }
                Some(FieldObservation::Ok(_) | FieldObservation::Bad { .. }) => SortCell::Bad,
            },
        })
        .collect()
}

pub fn compare_board_rows(
    sort: &SortSpec,
    left_rank: Option<&str>,
    left: &SortTuple,
    right_rank: Option<&str>,
    right: &SortTuple,
) -> DomainResult<Ordering> {
    match (left_rank, right_rank) {
        (Some(left_rank), Some(right_rank)) => Ok(left_rank
            .cmp(right_rank)
            .then_with(|| left.entity_id.cmp(&right.entity_id))),
        (Some(_), None) => Ok(Ordering::Less),
        (None, Some(_)) => Ok(Ordering::Greater),
        (None, None) => sort.compare(left, right),
    }
}

fn cursor_group(columns: &[GroupKey], group: &GroupKey) -> [SortCell; 2] {
    let (category, declared) = group_category(columns, group);
    let order = match (declared, group) {
        (Some(index), _) => SortCell::Value(ScalarValue::Number((index as u64).into())),
        (None, GroupKey::Value(value)) => SortCell::Value(value.clone()),
        _ => SortCell::Null,
    };
    [SortCell::Value(ScalarValue::Number(category.into())), order]
}

fn cursor_prefix(columns: &[GroupKey], group: &GroupKey, rank: Option<&str>) -> [SortCell; 4] {
    let [category, order] = cursor_group(columns, group);
    [
        category,
        order,
        SortCell::Value(ScalarValue::Bool(rank.is_none())),
        rank.map_or(SortCell::Null, |rank| {
            SortCell::Value(ScalarValue::String(rank.to_owned()))
        }),
    ]
}

fn group_prefix(cells: &[SortCell]) -> DomainResult<(u64, Option<&ScalarValue>)> {
    let Some([SortCell::Value(ScalarValue::Number(category)), order, ..]) = cells.get(..4) else {
        return Err(invalid_query());
    };
    match (category.as_json().as_u64(), order) {
        (Some(0), SortCell::Value(value @ ScalarValue::Number(number)))
            if number.as_json().is_u64() =>
        {
            Ok((0, Some(value)))
        }
        (Some(1), SortCell::Value(value)) => Ok((1, Some(value))),
        (Some(category @ 2..=4), SortCell::Null) => Ok((category, None)),
        _ => Err(invalid_query()),
    }
}

fn cursor_rank(cells: &[SortCell]) -> DomainResult<Option<&str>> {
    match cells.get(2..4) {
        Some([SortCell::Value(ScalarValue::Bool(true)), SortCell::Null]) => Ok(None),
        Some(
            [
                SortCell::Value(ScalarValue::Bool(false)),
                SortCell::Value(ScalarValue::String(rank)),
            ],
        ) if !rank.is_empty() => Ok(Some(rank)),
        _ => Err(invalid_query()),
    }
}

fn compare_group_prefix(left: &[SortCell], right: &[SortCell]) -> DomainResult<Ordering> {
    let (left_category, left_order) = group_prefix(left)?;
    let (right_category, right_order) = group_prefix(right)?;
    Ok(left_category
        .cmp(&right_category)
        .then_with(|| match (left_order, right_order) {
            (Some(left), Some(right)) => compare_scalar(left, right),
            _ => Ordering::Equal,
        }))
}

pub fn compare_view_cursor_tuple(
    sort: &SortSpec,
    left: &SortTuple,
    right: &SortTuple,
) -> DomainResult<Ordering> {
    let ordering = compare_group_prefix(&left.cells, &right.cells)?;
    let left_rank = cursor_rank(&left.cells)?;
    let right_rank = cursor_rank(&right.cells)?;
    if left.cells.len() != sort.keys().len() + 4 || right.cells.len() != sort.keys().len() + 4 {
        return Err(invalid_query());
    }
    if ordering != Ordering::Equal {
        return Ok(ordering);
    }
    match (left_rank, right_rank) {
        (Some(left_rank), Some(right_rank)) => Ok(left_rank
            .cmp(right_rank)
            .then_with(|| left.entity_id.cmp(&right.entity_id))),
        (Some(_), None) => Ok(Ordering::Less),
        (None, Some(_)) => Ok(Ordering::Greater),
        (None, None) => Ok(sort
            .compare_cells(&left.cells[4..], &right.cells[4..])?
            .then_with(|| left.entity_id.cmp(&right.entity_id))),
    }
}

#[derive(Clone, Debug)]
pub struct BoardRank {
    pub group: GroupKey,
    pub rank: String,
}

#[derive(Clone, Copy)]
pub struct WindowInput<'a> {
    pub index: &'a IndexView,
    pub store: &'a DerivedStore,
    pub scope: &'a HistoryScope,
    pub cut: SpaceSeq,
    /// Retained source/lifecycle universe, already intersected with current visibility.
    pub candidates: &'a Bitmap,
    pub filter: &'a Predicate,
    pub sort: &'a SortSpec,
    pub group_by: Option<&'a str>,
    pub columns: &'a [GroupKey],
    pub board: bool,
    pub ranks: &'a BTreeMap<u32, BoardRank>,
    /// Bounded exact replacements. Selection ignores their prior bitmap memberships.
    pub overlay: &'a BTreeMap<u32, ProjectedNote>,
    pub after: Option<&'a SortTuple>,
    pub limit: PageLimit,
}

#[derive(Debug)]
pub struct SelectedRow {
    pub dense_id: u32,
    pub tuple: SortTuple,
    pub group: GroupKey,
    pub rank: Option<String>,
}

#[derive(Debug)]
pub struct Selection {
    pub rows: Vec<SelectedRow>,
    pub groups: Vec<GroupCount>,
    pub has_more: bool,
}

pub async fn select_window(input: WindowInput<'_>) -> Result<Selection, PortError> {
    select_view_window(input, None, None).await
}

pub(crate) async fn select_view_window(
    input: WindowInput<'_>,
    rank_view: Option<&ViewRef>,
    verify_tags: Option<&BTreeSet<String>>,
) -> Result<Selection, PortError> {
    if input.board && input.group_by.is_none() {
        return Err(invalid_query().into());
    }
    let grouped = input.group_by.is_some() || input.board;
    if let Some(after) = input.after {
        if grouped {
            compare_view_cursor_tuple(input.sort, after, after)?;
        } else {
            input.sort.compare(after, after)?;
        }
    }

    let mut base = input.candidates.clone();
    for dense in input.overlay.keys() {
        base.remove(*dense);
    }
    let hits = input
        .index
        .filter_candidates(input.filter, &base)
        .map_err(index_failure)?;
    let mut matching = hits.definite;
    let uncertain = hits.uncertain;
    for page in dense_pages(&uncertain) {
        for note in query_rows(&input, &page).await? {
            if input.filter.matches(&note.evaluated_fields()?) {
                matching.add(note.dense_id);
            }
        }
    }
    if let Some(required_tags) = verify_tags.filter(|tags| !tags.is_empty()) {
        let mut verified = Bitmap::new();
        for page in dense_pages(&matching) {
            let rows = input.store.hydrate(input.scope, input.cut, &page).await?;
            for (note, expected) in rows.into_iter().zip(&page) {
                let note = note
                    .filter(|row| row.dense_id == *expected)
                    .ok_or_else(stale_cut)?;
                let inline: Vec<String> = crate::derived::decode_payload(&note.tags_msgpack)?;
                let raw: Option<BTreeMap<String, notarium_core::value::YamlValue>> =
                    crate::derived::decode_payload(&note.raw_fields_msgpack)?;
                let effective: BTreeSet<String> =
                    crate::runtime::records::effective_tags(&inline, raw.as_ref())
                        .into_iter()
                        .collect();
                if required_tags.is_subset(&effective) {
                    verified.add(note.dense_id);
                }
            }
        }
        matching = verified;
    }

    let header_sort = input
        .sort
        .keys()
        .iter()
        .all(|key| key.column == SortColumn::UpdatedAt);
    if header_sort {
        let partitions = match input.group_by {
            None => Some(vec![(GroupKey::Absent, matching.clone())]),
            Some(field) => group_partitions(&input, &matching, field)?,
        };
        if let Some(partitions) = partitions {
            return select_header_window(&input, grouped, &partitions, rank_view).await;
        }
    }

    let mut counts = GroupCounts::new(input.columns);
    let mut window = RowWindow::new(&input, grouped);
    for page in dense_pages(&matching) {
        let ranks = match rank_view {
            Some(view) => Some(candidate_ranks(&input, view, &page).await?),
            None => None,
        };
        let base = WindowInput {
            ranks: ranks.as_ref().unwrap_or(input.ranks),
            ..input
        };
        for note in query_rows(&input, &page).await? {
            let fields = note.evaluated_fields()?;
            collect_row(
                &base,
                &mut window,
                &mut counts,
                note.dense_id,
                &note.note_id,
                note.updated_at()?,
                &fields,
            )?;
        }
    }
    overlay_window(&input, &mut window, &mut counts)?;
    let groups = if grouped {
        counts.finish(input.columns)
    } else {
        Vec::new()
    };
    let rows = window.finish()?;
    Ok(finish_window(rows, groups, input.limit))
}

async fn select_header_window(
    input: &WindowInput<'_>,
    grouped: bool,
    partitions: &[(GroupKey, Bitmap)],
    rank_view: Option<&ViewRef>,
) -> Result<Selection, PortError> {
    let mut counts = GroupCounts::new(input.columns);
    let capacity = usize::from(input.limit.get()) + 1;
    let mut rows = Vec::with_capacity(capacity);
    for (group, ids) in partitions {
        if grouped {
            counts.increment(group, ids.cardinality());
        }
        let remaining = capacity - rows.len();
        if remaining > 0 && !ids.is_empty() {
            rows.extend(if let Some(view) = rank_view {
                ranked_header_window(input, view, ids, group, remaining).await?
            } else {
                header_window(input, ids, group, remaining)?
            });
        }
    }
    if !input.overlay.is_empty() {
        let mut merged = RowWindow::new(input, grouped);
        for row in rows {
            merged.push(row)?;
        }
        overlay_window(input, &mut merged, &mut counts)?;
        rows = merged.finish()?;
    }
    let groups = if grouped {
        counts.finish(input.columns)
    } else {
        Vec::new()
    };
    Ok(finish_window(rows, groups, input.limit))
}

async fn candidate_ranks(
    input: &WindowInput<'_>,
    view: &ViewRef,
    dense: &[u32],
) -> Result<BTreeMap<u32, BoardRank>, PortError> {
    let ids = dense
        .iter()
        .map(|&id| input.index.note_id(input.index.dense(id)))
        .collect::<DomainResult<Vec<_>>>()?;
    let rows = input
        .store
        .candidate_ranks(input.scope, input.cut, view, &ids)
        .await?;
    rows.into_iter()
        .map(|row| {
            let dense = input
                .index
                .dense_id(&row.target_note_id)
                .ok_or_else(stale_cut)?;
            Ok((
                dense,
                BoardRank {
                    group: row.group_key()?,
                    rank: row.sort_rank_lexo,
                },
            ))
        })
        .collect()
}

/// Take ranked rows in the group's SQL index order. Read only the rank keys
/// needed for this page. Exact replacement rows are merged separately.
async fn ranked_header_window(
    input: &WindowInput<'_>,
    view: &ViewRef,
    ids: &Bitmap,
    group: &GroupKey,
    capacity: usize,
) -> Result<Vec<SelectedRow>, PortError> {
    let prefix = cursor_prefix(input.columns, group, None);
    let mut same_group = None;
    if let Some(after) = input.after {
        match compare_group_prefix(&prefix, &after.cells)? {
            Ordering::Less => return Ok(Vec::new()),
            Ordering::Equal => same_group = Some(after),
            Ordering::Greater => {}
        }
    }
    // Small selections can address the target primary keys directly even when
    // the board has many ranks belonging to other filters or grants.
    let candidate_count = ids.cardinality();
    if candidate_count <= capacity as u64 && candidate_count <= 200 {
        let ranks = candidate_ranks(input, view, &ids.to_vec()).await?;
        return header_window(
            &WindowInput {
                ranks: &ranks,
                ..*input
            },
            ids,
            group,
            capacity,
        );
    }
    let group_hex = group_key_hex(group)?.1;
    let mut ranks = BTreeMap::new();
    let mut ranked = Bitmap::new();
    let mut start = match same_group {
        Some(cursor) => {
            cursor_rank(&cursor.cells)?.map(|rank| (rank.to_owned(), cursor.entity_id.clone()))
        }
        None => None,
    };
    if same_group.is_none() || start.is_some() {
        let mut scanned = 0u64;
        loop {
            let limit = rank_page_limit(capacity, scanned, candidate_count - scanned)?;
            let page = input
                .store
                .group_rank_page(
                    input.scope,
                    input.cut,
                    view,
                    &group_hex,
                    GroupRankRange {
                        after: start.as_ref().map(|(r, id)| (r.as_str(), id)),
                        through: None,
                    },
                    limit,
                )
                .await?;
            scanned += page.len() as u64;
            let end = page.len() < usize::from(limit.get());
            start = page
                .last()
                .map(|r| (r.sort_rank_lexo.clone(), r.target_note_id.clone()));
            for r in page {
                if ranks.len() < capacity
                    && let Some(dense) = input
                        .index
                        .dense_id(&r.target_note_id)
                        .filter(|id| ids.contains(*id))
                {
                    ranked.add(dense);
                    ranks.insert(
                        dense,
                        BoardRank {
                            group: group.clone(),
                            rank: r.sort_rank_lexo,
                        },
                    );
                }
            }
            if ranks.len() == capacity || end {
                break;
            }
            if scanned >= candidate_count {
                // Beyond this point, seeking the already-filtered candidates
                // by target is cheaper than walking unrelated placements.
                let mut best = BoundedHeap::new(capacity);
                for page in dense_pages(ids) {
                    let ranks = candidate_ranks(input, view, &page).await?;
                    let local = WindowInput {
                        ranks: &ranks,
                        ..*input
                    };
                    let subset = Bitmap::from(&page[..]);
                    for row in header_window(&local, &subset, group, capacity)? {
                        best.push(row, |a, b| {
                            compare_view_cursor_tuple(input.sort, &a.tuple, &b.tuple)
                        })?;
                    }
                }
                return Ok(
                    best.finish(|a, b| compare_view_cursor_tuple(input.sort, &a.tuple, &b.tuple))?
                );
            }
        }
    }
    let local = WindowInput {
        ranks: &ranks,
        ..*input
    };
    let mut rows = header_window(&local, &ranked, group, capacity)?;
    if rows.len() < capacity {
        let remaining = capacity - rows.len();
        // The rank scan has exhausted the eligible suffix. When it started at
        // the beginning of the group, all remaining IDs are already unranked.
        let remaining_ids = ids.andnot(&ranked);
        rows.extend(if let Some(cursor) = same_group {
            continued_unranked_window(
                &local,
                view,
                group,
                &group_hex,
                remaining_ids,
                cursor,
                remaining,
            )
            .await?
        } else {
            header_window(&local, &remaining_ids, group, remaining)?
        });
    }
    Ok(rows)
}

// Grow a range scan when placements have been skipped, with one bounded SQL
// batch and at most as many new positions as the remaining candidate budget.
fn rank_page_limit(first: usize, scanned: u64, budget: u64) -> DomainResult<PageLimit> {
    PageLimit::new((first as u64).max(2 * scanned).min(budget).clamp(1, 200) as u16)
}

/// The suffix after a ranked cursor has already been exhausted. Read the
/// disjoint prefix through that cursor, or the full group for an ordinary cursor.
async fn continued_unranked_window(
    input: &WindowInput<'_>,
    view: &ViewRef,
    group: &GroupKey,
    group_hex: &str,
    mut candidates: Bitmap,
    cursor: &SortTuple,
    capacity: usize,
) -> Result<Vec<SelectedRow>, PortError> {
    let through = cursor_rank(&cursor.cells)?.map(|rank| (rank, &cursor.entity_id));
    let mut start = None::<(String, NoteId)>;
    let mut scanned = 0;
    let mut remaining = candidates.cardinality();
    // Candidate checks cost one lookup per remaining ID. Switch to them only
    // once the index has actually yielded at least that many physical ranks.
    while scanned < remaining {
        let first = start.is_none();
        let limit = rank_page_limit(
            usize::from(input.limit.get()) + 1,
            scanned,
            remaining - scanned,
        )?;
        let page = input
            .store
            .group_rank_page(
                input.scope,
                input.cut,
                view,
                group_hex,
                GroupRankRange {
                    after: start.as_ref().map(|(rank, id)| (rank.as_str(), id)),
                    through,
                },
                limit,
            )
            .await?;
        scanned += page.len() as u64;
        let exhausted = page.len() < usize::from(limit.get())
            || page.last().zip(through).is_some_and(|(last, position)| {
                (last.sort_rank_lexo.as_str(), &last.target_note_id) == position
            });
        start = page
            .last()
            .map(|row| (row.sort_rank_lexo.clone(), row.target_note_id.clone()));
        for row in page {
            if let Some(dense) = input.index.dense_id(&row.target_note_id)
                && candidates.remove_checked(dense)
            {
                remaining -= 1;
            }
        }
        if exhausted || remaining == 0 {
            return header_window(input, &candidates, group, capacity);
        }
        // In a dense group the leading timestamp candidates may already fill
        // the page. Try this once; a short result resumes the same rank scan.
        if first
            && scanned < remaining
            && let Some(window) =
                verified_ordinary_window(input, view, group, group_hex, &candidates, capacity)
                    .await?
        {
            return Ok(window);
        }
    }
    let mut unranked = Bitmap::new();
    let mut iter = candidates.iter();
    let mut batch = [0; 2048];
    loop {
        let n = iter.next_many(&mut batch);
        if n == 0 {
            break;
        }
        let found = input
            .store
            .unranked_candidates(input.scope, input.cut, view, group_hex, &batch[..n])
            .await?;
        unranked.add_many(&found);
    }
    header_window(input, &unranked, group, capacity)
}

async fn verified_ordinary_window(
    input: &WindowInput<'_>,
    view: &ViewRef,
    group: &GroupKey,
    group_hex: &str,
    candidates: &Bitmap,
    capacity: usize,
) -> Result<Option<Vec<SelectedRow>>, PortError> {
    let preview_limit = (2 * capacity).min(201);
    let preview = header_window(input, candidates, group, preview_limit)?;
    if preview.is_empty() {
        return Ok(Some(preview));
    }
    let exhausted = preview.len() < preview_limit;
    let ids = preview.iter().map(|r| r.dense_id).collect::<Vec<_>>();
    let ordinary = input
        .store
        .unranked_candidates(input.scope, input.cut, view, group_hex, &ids)
        .await?;
    let ordinary = Bitmap::from(ordinary.as_slice());
    let window: Vec<_> = preview
        .into_iter()
        .filter(|r| ordinary.contains(r.dense_id))
        .take(capacity)
        .collect();
    Ok((window.len() == capacity || exhausted).then_some(window))
}

fn overlay_window(
    input: &WindowInput<'_>,
    window: &mut RowWindow<'_>,
    counts: &mut GroupCounts,
) -> Result<(), PortError> {
    for (&dense, note) in input.overlay {
        if !input.candidates.contains(dense) {
            continue;
        }
        if note.dense_id != dense || note.space_id != input.scope.space_id {
            return Err(stale_cut());
        }
        let fields = note.evaluated_fields()?;
        if input.filter.matches(&fields) {
            collect_row(
                input,
                window,
                counts,
                dense,
                &note.note_id,
                note.updated_at()?,
                &fields,
            )?;
        }
    }
    Ok(())
}

fn finish_window(
    mut rows: Vec<SelectedRow>,
    groups: Vec<GroupCount>,
    limit: PageLimit,
) -> Selection {
    let has_more = rows.len() > usize::from(limit.get());
    rows.truncate(usize::from(limit.get()));
    Selection {
        rows,
        groups,
        has_more,
    }
}

async fn query_rows(
    input: &WindowInput<'_>,
    ids: &[u32],
) -> Result<Vec<ProjectedQueryRow>, PortError> {
    let rows = input
        .store
        .hydrate_query_rows(input.scope, input.cut, ids)
        .await?;
    if rows.len() != ids.len() {
        return Err(stale_cut());
    }
    rows.into_iter()
        .zip(ids)
        .map(|(note, expected)| {
            note.filter(|note| note.dense_id == *expected)
                .ok_or_else(stale_cut)
        })
        .collect()
}

fn dense_pages(bitmap: &Bitmap) -> impl Iterator<Item = Vec<u32>> + '_ {
    let mut ids = bitmap.iter();
    std::iter::from_fn(move || {
        let ids: Vec<_> = ids.by_ref().take(200).collect();
        (!ids.is_empty()).then_some(ids)
    })
}

fn group_partitions(
    input: &WindowInput<'_>,
    matching: &Bitmap,
    field: &str,
) -> Result<Option<Vec<(GroupKey, Bitmap)>>, PortError> {
    if let Some(values) = input
        .index
        .direct_scalar_values(field, 64)
        .map_err(index_failure)?
    {
        return build_exact_group_partitions(input, matching, field, &values, false);
    }
    // Numeric/date/timestamp boards use BSI bit-slices rather than direct
    // scalar postings. When the board declares explicit columns, try exact BSI
    // partitioning and accept it if those columns cover every matching row.
    if !input.columns.is_empty() {
        let values: Vec<ScalarValue> = input
            .columns
            .iter()
            .filter_map(|group| match group {
                GroupKey::Value(value) => Some(value.clone()),
                _ => None,
            })
            .collect();
        return build_exact_group_partitions(input, matching, field, &values, true);
    }
    Ok(None)
}

fn build_exact_group_partitions(
    input: &WindowInput<'_>,
    matching: &Bitmap,
    field: &str,
    values: &[ScalarValue],
    require_full_coverage: bool,
) -> Result<Option<Vec<(GroupKey, Bitmap)>>, PortError> {
    let mut known = Bitmap::new();
    let mut partitions = Vec::with_capacity(values.len() + input.columns.len() + 3);
    let mut add = |group, ids: Bitmap| {
        known.or_inplace(&ids);
        if !ids.is_empty() || input.columns.contains(&group) {
            partitions.push((group, ids));
        }
    };
    for value in values {
        let hits = input
            .index
            .filter_candidates(
                &Predicate::Eq {
                    key: field.to_owned(),
                    value: value.clone(),
                },
                matching,
            )
            .map_err(index_failure)?;
        if !hits.uncertain.is_empty() {
            return Ok(None);
        }
        add(GroupKey::Value(value.clone()), hits.definite);
    }
    let empty = posting(input.index, &PostingKey::FieldEmptyList(field.into()))?;
    add(GroupKey::EmptyList, matching.and(&empty));
    let ok = posting(input.index, &PostingKey::FieldOk(field.into()))?;
    let bad = posting(input.index, &PostingKey::FieldBad(field.into()))?;
    let mut assigned = ok.or(&bad);
    assigned.and_inplace(matching);
    if require_full_coverage {
        // Under BSI/declared-column partitioning, any ok row not matched by an
        // explicit column or EmptyList belongs to an undeclared scalar value
        // (or Map/non-empty List), so fall back to SQL exact grouping.
        let mut ok_in_matching = ok;
        ok_in_matching.and_inplace(matching);
        if !ok_in_matching.andnot(&known).is_empty() {
            return Ok(None);
        }
        let mut bad_in_matching = bad;
        bad_in_matching.and_inplace(matching);
        if !bad_in_matching.is_empty() || input.columns.contains(&GroupKey::Bad) {
            partitions.push((GroupKey::Bad, bad_in_matching));
        }
    } else {
        let unreadable = assigned.andnot(&known);
        if !unreadable.is_empty() || input.columns.contains(&GroupKey::Bad) {
            partitions.push((GroupKey::Bad, unreadable));
        }
    }
    let absent = matching.andnot(&assigned);
    if !absent.is_empty() || input.columns.contains(&GroupKey::Absent) {
        partitions.push((GroupKey::Absent, absent));
    }
    for declared in input.columns {
        if !partitions.iter().any(|(group, _)| group == declared) {
            partitions.push((declared.clone(), Bitmap::new()));
        }
    }
    partitions.sort_by(|(left, _), (right, _)| compare_group_keys(input.columns, left, right));
    Ok(Some(partitions))
}

// The common timestamp sort stays on mmap pages until at most 201 rows survive
// the heap. A custom field selection uses the same comparator with SQL values.
fn header_window<'a>(
    input: &'a WindowInput<'_>,
    matching: &Bitmap,
    group: &GroupKey,
    capacity: usize,
) -> Result<Vec<SelectedRow>, PortError> {
    let direction = input.sort.keys()[0].direction;
    let grouped = input.group_by.is_some() || input.board;
    let group_prefix_cells = cursor_prefix(input.columns, group, None);
    let cursor_group = input
        .after
        .map(|after| {
            if grouped {
                compare_group_prefix(&group_prefix_cells, &after.cells)
            } else {
                Ok(Ordering::Equal)
            }
        })
        .transpose()?;
    if cursor_group == Some(Ordering::Less) {
        return Ok(Vec::new());
    }
    let after = if let Some(after) = input
        .after
        .filter(|_| cursor_group == Some(Ordering::Equal))
    {
        let offset = if grouped { 4 } else { 0 };
        let Some(SortCell::Value(ScalarValue::Timestamp(time))) = after.cells.get(offset) else {
            return Err(invalid_query().into());
        };
        let nanos = time.nanosecond();
        let key = HeaderKey {
            rank: if grouped {
                cursor_rank(&after.cells)?
            } else {
                None
            },
            updated: (
                time.unix_seconds() * 1_000 + i64::from(nanos / 1_000_000),
                ((nanos % 1_000_000) / 1_000) as u16,
            ),
        };
        Some((after, key, (nanos % 1_000) as u16))
    } else {
        None
    };

    let index: &'a IndexView = input.index;
    let compare = |left: &HeaderRow<'a>, right: &HeaderRow<'a>| {
        left.key.compare(
            right.key,
            direction,
            || Ok(left.nanos(index)?.cmp(&right.nanos(index)?)),
            || Ok(left.note(index)?.cmp(right.note(index)?)),
        )
    };

    let mut best = BoundedHeap::new(capacity);
    for dense_id in matching.iter() {
        let row = HeaderRow {
            key: HeaderKey {
                rank: admitted_rank(input, dense_id, group)?,
                updated: index.updated_at_prefix(dense_id).ok_or_else(stale_cut)?,
            },
            dense_id,
            nanos: Cell::new(None),
            note: Cell::new(None),
        };
        if let Some((after, key, nanos)) = after {
            let ordering = row.key.compare(
                key,
                direction,
                || Ok(row.nanos(index)?.cmp(&nanos)),
                || Ok(row.note(index)?.cmp(after.entity_id.as_str())),
            )?;
            if ordering != Ordering::Greater {
                continue;
            }
        }
        best.push(row, compare)?;
    }
    best.finish(compare)?
        .into_iter()
        .map(|row| {
            let note = NoteId::parse(row.note(index)?)?;
            let updated = index.updated_at(row.dense_id).ok_or_else(stale_cut)?;
            let mut tuple = sort_tuple(input.sort, &note, updated, &BTreeMap::new());
            if grouped {
                tuple
                    .cells
                    .splice(..0, cursor_prefix(input.columns, group, row.key.rank));
            }
            Ok(SelectedRow {
                dense_id: row.dense_id,
                tuple,
                group: group.clone(),
                rank: row.key.rank.map(str::to_owned),
            })
        })
        .collect()
}

#[derive(Clone, Copy)]
struct HeaderKey<'a> {
    rank: Option<&'a str>,
    updated: (i64, u16),
}

impl HeaderKey<'_> {
    fn compare(
        self,
        other: Self,
        direction: Direction,
        compare_nanos: impl FnOnce() -> DomainResult<Ordering>,
        compare_note: impl FnOnce() -> DomainResult<Ordering>,
    ) -> DomainResult<Ordering> {
        let order = match (self.rank, other.rank) {
            (Some(left), Some(right)) => left.cmp(right),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => {
                // The microsecond prefix decides before touching the sparse
                // nanosecond section. Equal ranks use NoteId directly.
                let mut order = self.updated.cmp(&other.updated);
                if order == Ordering::Equal {
                    order = compare_nanos()?;
                }
                match direction {
                    Direction::Asc => order,
                    Direction::Desc => order.reverse(),
                }
            }
        };
        if order == Ordering::Equal {
            return compare_note();
        }
        Ok(order)
    }
}

struct HeaderRow<'a> {
    key: HeaderKey<'a>,
    dense_id: u32,
    // A row can appear in several heap comparisons. Resolve each suffix
    // lazily once while it is in the bounded heap.
    nanos: Cell<Option<u16>>,
    note: Cell<Option<&'a str>>,
}

impl<'a> HeaderRow<'a> {
    fn nanos(&self, index: &IndexView) -> DomainResult<u16> {
        if let Some(nanos) = self.nanos.get() {
            return Ok(nanos);
        }
        let nanos = index
            .note_header(self.dense_id)
            .ok_or_else(|| DomainError::validation(ValidationReason::CursorStale))?
            .ns_remainder();
        self.nanos.set(Some(nanos));
        Ok(nanos)
    }

    fn note(&self, index: &'a IndexView) -> DomainResult<&'a str> {
        if let Some(note) = self.note.get() {
            return Ok(note);
        }
        let note = index
            .note_id_str(self.dense_id)
            .ok_or_else(|| DomainError::validation(ValidationReason::CursorStale))?;
        self.note.set(Some(note));
        Ok(note)
    }
}

fn exact_number_same_encoding(left: &ExactNumber, right: &ExactNumber) -> bool {
    let l = left.as_json();
    let r = right.as_json();
    if let (Some(a), Some(b)) = (l.as_u64(), r.as_u64()) {
        return a == b;
    }
    if let (Some(a), Some(b)) = (l.as_i64(), r.as_i64()) {
        return a == b;
    }
    if l.is_f64() && r.is_f64() {
        return l.as_f64().map(f64::to_bits) == r.as_f64().map(f64::to_bits);
    }
    false
}

fn admitted_rank<'a>(
    input: &'a WindowInput<'_>,
    dense_id: u32,
    group: &GroupKey,
) -> Result<Option<&'a str>, PortError> {
    if !input.board {
        return Ok(None);
    }
    let Some(rank) = input
        .ranks
        .get(&dense_id)
        .filter(|rank| &rank.group == group)
    else {
        return Ok(None);
    };
    // The canonical writer binds a ranked placement to the group's encoded
    // identity. Equal numeric values can still carry different authored kinds.
    if let (
        GroupKey::Value(ScalarValue::Number(rank_num)),
        GroupKey::Value(ScalarValue::Number(group_num)),
    ) = (&rank.group, group)
        && !exact_number_same_encoding(rank_num, group_num)
    {
        return Ok(None);
    }
    Ok(Some(&rank.rank))
}

fn collect_row(
    input: &WindowInput<'_>,
    window: &mut RowWindow<'_>,
    counts: &mut GroupCounts,
    dense_id: u32,
    note: &NoteId,
    updated: Timestamp,
    fields: &FieldObservations,
) -> Result<(), PortError> {
    let group = group_key(input.group_by.and_then(|key| fields.get(key)));
    let rank = admitted_rank(input, dense_id, &group)?;
    let mut tuple = sort_tuple(input.sort, note, updated, fields);
    if window.grouped {
        counts.increment(&group, 1);
        tuple
            .cells
            .splice(..0, cursor_prefix(input.columns, &group, rank));
    }
    window.push(SelectedRow {
        dense_id,
        tuple,
        group,
        rank: rank.map(str::to_owned),
    })?;
    Ok(())
}

struct GroupOrder(GroupKey);

impl Eq for GroupOrder {}

impl PartialEq for GroupOrder {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Ord for GroupOrder {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_group_keys(&[], &self.0, &other.0)
    }
}

impl PartialOrd for GroupOrder {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct GroupCounts(BTreeMap<GroupOrder, u64>);

impl GroupCounts {
    fn new(columns: &[GroupKey]) -> Self {
        Self(
            columns
                .iter()
                .cloned()
                .map(|group| (GroupOrder(group), 0))
                .collect(),
        )
    }

    fn increment(&mut self, group: &GroupKey, increment: u64) {
        match self.0.entry(GroupOrder(group.clone())) {
            Entry::Occupied(mut entry) => *entry.get_mut() += increment,
            Entry::Vacant(entry) => {
                entry.insert(increment);
            }
        }
    }

    fn finish(self, columns: &[GroupKey]) -> Vec<GroupCount> {
        let mut values: Vec<_> = self
            .0
            .into_iter()
            .map(|(GroupOrder(group), count)| GroupCount { group, count })
            .collect();
        values.sort_by(|left, right| compare_group_keys(columns, &left.group, &right.group));
        values
    }
}

struct RowWindow<'a> {
    sort: &'a SortSpec,
    grouped: bool,
    after: Option<&'a SortTuple>,
    rows: BoundedHeap<SelectedRow>,
}

impl<'a> RowWindow<'a> {
    fn new(input: &'a WindowInput<'_>, grouped: bool) -> Self {
        Self {
            sort: input.sort,
            grouped,
            after: input.after,
            rows: BoundedHeap::new(usize::from(input.limit.get()) + 1),
        }
    }

    fn push(&mut self, row: SelectedRow) -> DomainResult<()> {
        let sort = self.sort;
        let grouped = self.grouped;
        if let Some(after) = self.after
            && compare_window_tuple(sort, grouped, &row.tuple, after)? != Ordering::Greater
        {
            return Ok(());
        }
        self.rows.push(row, |left, right| {
            compare_window_tuple(sort, grouped, &left.tuple, &right.tuple)
        })
    }

    fn finish(self) -> DomainResult<Vec<SelectedRow>> {
        self.rows.finish(|left, right| {
            compare_window_tuple(self.sort, self.grouped, &left.tuple, &right.tuple)
        })
    }
}

fn compare_window_tuple(
    sort: &SortSpec,
    grouped: bool,
    left: &SortTuple,
    right: &SortTuple,
) -> DomainResult<Ordering> {
    if grouped {
        compare_view_cursor_tuple(sort, left, right)
    } else {
        sort.compare(left, right)
    }
}

/// Keeps the smallest items under the supplied fallible total order. A bounded
/// heap avoids a corpus-sized sort key allocation for a small page.
struct BoundedHeap<T> {
    values: Vec<T>,
    capacity: usize,
}

impl<T> BoundedHeap<T> {
    fn new(capacity: usize) -> Self {
        Self {
            values: Vec::with_capacity(capacity),
            capacity,
        }
    }

    fn push(
        &mut self,
        value: T,
        compare: impl Fn(&T, &T) -> DomainResult<Ordering>,
    ) -> DomainResult<()> {
        if self.values.len() == self.capacity {
            if compare(&value, &self.values[0])? == Ordering::Less {
                self.values[0] = value;
                self.sift_down(0, &compare)?;
            }
            return Ok(());
        }
        self.values.push(value);
        let mut index = self.values.len() - 1;
        while index > 0 {
            let parent = (index - 1) / 2;
            if compare(&self.values[index], &self.values[parent])? != Ordering::Greater {
                break;
            }
            self.values.swap(index, parent);
            index = parent;
        }
        Ok(())
    }

    fn sift_down(
        &mut self,
        mut root: usize,
        compare: &impl Fn(&T, &T) -> DomainResult<Ordering>,
    ) -> DomainResult<()> {
        while root * 2 + 1 < self.values.len() {
            let left = root * 2 + 1;
            let right = left + 1;
            let child = if right < self.values.len()
                && compare(&self.values[right], &self.values[left])? == Ordering::Greater
            {
                right
            } else {
                left
            };
            if compare(&self.values[child], &self.values[root])? != Ordering::Greater {
                break;
            }
            self.values.swap(root, child);
            root = child;
        }
        Ok(())
    }

    fn finish(
        mut self,
        compare: impl Fn(&T, &T) -> DomainResult<Ordering>,
    ) -> DomainResult<Vec<T>> {
        let mut values = Vec::with_capacity(self.values.len());
        while let Some(last) = self.values.pop() {
            if self.values.is_empty() {
                values.push(last);
            } else {
                values.push(std::mem::replace(&mut self.values[0], last));
                self.sift_down(0, &compare)?;
            }
        }
        values.reverse();
        Ok(values)
    }
}

#[cfg(test)]
mod tests;
