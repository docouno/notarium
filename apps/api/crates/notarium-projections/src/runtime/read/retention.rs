use std::{collections::BTreeMap, mem::size_of};

use notarium_core::{
    ports::GroupKey,
    query::{Predicate, SortColumn, SortSpec},
    value::ScalarValue,
};

use super::{ExactRow, PreparedView, ReadState, RetainedQuery};
use crate::{derived::ProjectedViewRank, nota::SourceFolder};

// Fixed allowance covers bounded identities, receipts and container metadata.
// Variable-size user data is charged separately at its allocation capacity.
pub(super) fn page_bytes(
    query: &RetainedQuery,
    view: Option<&PreparedView>,
    overlay: &BTreeMap<u32, ExactRow>,
) -> usize {
    let mut bytes = size_of::<ReadState>() + 4096;
    match query {
        RetainedQuery::Notes(query) => {
            bytes += predicate_bytes(&query.filter.predicate) + sort_bytes(&query.sort);
        }
        RetainedQuery::View(query) => {
            bytes += predicate_bytes(&query.filter.predicate)
                + query.sort.as_ref().map_or(0, sort_bytes)
                + query.group_by.as_ref().map_or(0, String::capacity);
        }
    }
    if let Some(view) = view {
        bytes += predicate_bytes(&view.plan.filter)
            + sort_bytes(&view.plan.sort)
            + view.plan.group_by.as_ref().map_or(0, String::capacity)
            + view.columns.capacity() * size_of::<GroupKey>();
        for group in &view.columns {
            if let GroupKey::Value(value) = group {
                bytes += scalar_bytes(value);
            }
        }
        if let Some(SourceFolder::Path(path)) = &view.source.folder {
            bytes += path.capacity();
        }
        bytes += view
            .source
            .tags
            .iter()
            .map(|tag| 64 + tag.capacity())
            .sum::<usize>();
    }
    for row in overlay.values() {
        let n = &row.note;
        bytes += size_of::<ExactRow>()
            + 512
            + row.location.dense.capacity() * size_of::<u32>()
            + row.location.ids.capacity() * size_of::<notarium_core::ids::FolderId>()
            + row.location.display_path.capacity()
            + row.location.norm_path.capacity()
            + n.tags_msgpack.capacity()
            + n.view_blocks_msgpack.capacity()
            + n.raw_fields_msgpack.capacity()
            + n.evaluated_fields_msgpack.capacity()
            + n.header_diagnostic_msgpack.capacity()
            + n.diagnostics_msgpack.capacity()
            + n.preview.capacity()
            + n.title.capacity()
            + n.title_fold.capacity()
            + n.slug.capacity()
            + n.slug_fold.capacity()
            + row.ranks.capacity() * size_of::<ProjectedViewRank>();
        for rank in &row.ranks {
            bytes += 320
                + rank.group_key_msgpack.capacity()
                + rank.group_key_hex.capacity()
                + rank.sort_rank_lexo.capacity();
        }
    }
    bytes
}

fn predicate_bytes(pred: &Predicate) -> usize {
    match pred {
        Predicate::All(terms) | Predicate::Any(terms) => {
            terms.capacity() * size_of::<Predicate>()
                + terms.iter().map(predicate_bytes).sum::<usize>()
        }
        Predicate::Not(term) => size_of::<Predicate>() + predicate_bytes(term),
        Predicate::Eq { key, value } | Predicate::Contains { key, value } => {
            key.capacity() + scalar_bytes(value)
        }
        Predicate::Exists { key }
        | Predicate::IsAbsent { key }
        | Predicate::IsBad { key }
        | Predicate::NumberRange { key, .. }
        | Predicate::DateRange { key, .. }
        | Predicate::TimestampRange { key, .. } => key.capacity(),
    }
}

fn sort_bytes(sort: &SortSpec) -> usize {
    std::mem::size_of_val(sort.keys())
        + sort
            .keys()
            .iter()
            .map(|key| match &key.column {
                SortColumn::Field { key, .. } => key.capacity(),
                SortColumn::UpdatedAt => 0,
            })
            .sum::<usize>()
}

fn scalar_bytes(value: &ScalarValue) -> usize {
    match value {
        ScalarValue::String(s) => s.capacity(),
        _ => 0,
    }
}
