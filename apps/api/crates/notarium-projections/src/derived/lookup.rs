use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ClusterId, FolderId, NoteId, SpaceId, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::PageLimit,
};

use super::{
    CandidateLookupKey, DerivedStore, ProjectedCluster, ProjectedLink, ProjectedNoteAlias,
    invalid_row, not_ready,
    read::{assert_cut, watermark},
    sql::{Kind, SqlColumn, SqlRecord, value},
};
use crate::links::{
    AliasKey, CandidatePosition, CandidateQuery, NoteAliasPosition, ResolutionIndex,
};

impl ResolutionIndex for DerivedStore {
    async fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> Result<Vec<CandidateLookupKey>, PortError> {
        PageLimit::new(limit)?;
        if query.min_tier > query.max_tier {
            return Ok(Vec::new());
        }
        let mut filter =
            String::from("WHERE space_id = ? AND scope_folder_dense_id = ? AND leaf_norm_key = ?");
        let mut params = vec![
            value(query.space),
            value(&query.folder),
            value(&query.leaf.to_owned()),
        ];
        if query.min_tier == query.max_tier {
            if let Some(after) = after
                && after.tier > query.max_tier
            {
                return Ok(Vec::new());
            }
            filter.push_str(" AND tier = ?");
            params.push(value(&query.min_tier));
            if let Some(note) = query.exact_note {
                filter.push_str(" AND target_note_id = ?");
                params.push(value(&note.to_owned()));
            }
            if let Some(after) = after
                && after.tier == query.min_tier
            {
                filter
                    .push_str(" AND (created_at_sec, created_at_nsec, target_note_id) > (?, ?, ?)");
                params.extend([
                    value(&after.created_at_sec),
                    value(&after.created_at_nsec),
                    value(&after.note),
                ]);
            }
            filter.push_str(" ORDER BY created_at_sec, created_at_nsec, target_note_id LIMIT ?");
        } else {
            if let Some(after) = after
                && after.tier >= query.min_tier
            {
                if after.tier > query.max_tier {
                    return Ok(Vec::new());
                }
                filter.push_str(
                    " AND tier <= ? AND (tier, created_at_sec, created_at_nsec, target_note_id) > (?, ?, ?, ?)",
                );
                params.extend([
                    value(&query.max_tier),
                    value(&after.tier),
                    value(&after.created_at_sec),
                    value(&after.created_at_nsec),
                    value(&after.note),
                ]);
            } else {
                filter.push_str(" AND tier >= ? AND tier <= ?");
                params.extend([value(&query.min_tier), value(&query.max_tier)]);
            }
            if let Some(note) = query.exact_note {
                filter.push_str(" AND target_note_id = ?");
                params.push(value(&note.to_owned()));
            }
            filter.push_str(
                " ORDER BY tier, created_at_sec, created_at_nsec, target_note_id LIMIT ?",
            );
        }
        params.push(value(&i64::from(limit)));
        self.select_current(filter, params).await
    }

    async fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        let limit = PageLimit::new(limit)?;
        match selector {
            AliasKey::Slug => {
                // Index: projected_note_alias_slug (space_id, old_slug_fold, old_parent_folder_id, created_seq, target_note_id)
                let mut filter = String::from("WHERE space_id = ? AND old_slug_fold = ?");
                let mut params = vec![value(space), value(&leaf.to_owned())];
                if let Some(after) = after {
                    filter.push_str(
                        " AND (old_parent_folder_id, created_seq, target_note_id) > (?, ?, ?)",
                    );
                    params.extend([value(&after.parent), value(&after.seq), value(&after.note)]);
                }
                filter.push_str(
                    " ORDER BY old_parent_folder_id, created_seq, target_note_id LIMIT ?",
                );
                params.push(value(&i64::from(limit.get())));
                self.select_current(filter, params).await
            }
            AliasKey::Title => {
                // Index: projected_note_alias_title (space_id, old_title_norm, old_parent_folder_id, old_slug_fold, created_seq, target_note_id)
                let mut filter = String::from("WHERE space_id = ? AND old_title_norm = ?");
                let mut params = vec![value(space), value(&leaf.to_owned())];
                if let Some(after) = after {
                    filter.push_str(" AND (old_parent_folder_id, old_slug_fold, created_seq, target_note_id) > (?, ?, ?, ?)");
                    params.extend([
                        value(&after.parent),
                        value(&after.slug),
                        value(&after.seq),
                        value(&after.note),
                    ]);
                }
                filter.push_str(
                    " ORDER BY old_parent_folder_id, old_slug_fold, created_seq, target_note_id LIMIT ?",
                );
                params.push(value(&i64::from(limit.get())));
                self.select_current(filter, params).await
            }
        }
    }

    async fn slot_occupant(
        &self,
        space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> Result<Option<NoteId>, PortError> {
        let params = vec![
            value(space),
            value(parent),
            value(&slug.to_owned()),
            value(&Lifecycle::Active),
        ];
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let mut rows = tx
                        .select(
                            "SELECT note_id FROM projected_notes \
                 WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ? AND lifecycle = ? \
                 LIMIT 2",
                            params,
                            &[Kind::Text],
                        )
                        .await?;
                    if rows.len() > 1 {
                        return Err(DomainError::validation(ValidationReason::InvalidState).into());
                    }
                    rows.pop()
                        .and_then(|mut row| row.pop())
                        .map(NoteId::read)
                        .transpose()
                })
            })
            .await
    }
}

#[derive(Clone, Copy)]
pub(crate) enum LinkAddress<'a> {
    Leaf(&'a str),
    Target(u32),
    Prefix(&'a str),
    RelativeSource(&'a FolderId),
    Source(u32),
}

#[derive(Clone, Debug)]
pub(crate) struct LinkPosition {
    prefix: String,
    source: u32,
    ordinal: u32,
}

impl LinkPosition {
    pub(crate) fn from_key(source: u32, ordinal: u32) -> Self {
        Self {
            prefix: String::new(),
            source,
            ordinal,
        }
    }
}

impl From<&ProjectedLink> for LinkPosition {
    fn from(link: &ProjectedLink) -> Self {
        Self {
            prefix: link.dir_norm_prefix.clone(),
            source: link.src_dense_id,
            ordinal: link.link_ord,
        }
    }
}

impl DerivedStore {
    pub(crate) async fn graph_clusters_page(
        &self,
        scope: &HistoryScope,
        settled: SpaceSeq,
        after: Option<&ClusterId>,
        only: Option<&ClusterId>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedCluster>, PortError> {
        let scope = scope.clone();
        let mut filter = String::from("WHERE space_id = ? AND updated_seq = ?");
        let mut params = vec![value(&scope.space_id), value(&settled)];
        if let Some(after) = after {
            filter.push_str(" AND cluster_id > ?");
            params.push(value(after));
        }
        if let Some(only) = only {
            filter.push_str(" AND cluster_id = ?");
            params.push(value(only));
        }
        filter.push_str(" ORDER BY cluster_id LIMIT ?");
        params.push(value(&limit.get()));
        let columns = ProjectedCluster::columns();
        let sql = format!("SELECT {columns} FROM graph_clusters {filter}");
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(not_ready)?;
                    assert_cut(&row, &scope, row.projected_seq)?;
                    if row.graph_settled_seq != settled {
                        return Err(super::stale());
                    }
                    tx.records(&sql, params).await
                })
            })
            .await
    }

    pub(crate) async fn is_link_source_active(
        &self,
        space: &SpaceId,
        source: u32,
    ) -> Result<bool, PortError> {
        let params = vec![
            value(space),
            value(&source),
            value(&Lifecycle::Active),
            value(&DocClass::EncryptedNote),
        ];
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let rows = tx
                        .select(
                            "SELECT dense_id FROM projected_notes \
                 WHERE space_id = ? AND dense_id = ? AND lifecycle = ? AND doc_class <> ?",
                            params,
                            &[Kind::Integer],
                        )
                        .await?;
                    Ok(!rows.is_empty())
                })
            })
            .await
    }

    pub(crate) async fn link_page_at(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        address: LinkAddress<'_>,
        after: Option<&LinkPosition>,
        limit: u16,
    ) -> Result<Vec<ProjectedLink>, PortError> {
        if limit == 0 || limit > 201 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let (mut filter, key) = match address {
            LinkAddress::Source(source) => ("src_dense_id = ?".to_owned(), source),
            LinkAddress::Target(target) => ("resolved_dense_id = ?".to_owned(), target),
            _ => return Err(DomainError::validation(ValidationReason::InvalidQuery).into()),
        };
        let mut params = vec![value(&key)];
        if let Some(after) = after {
            filter.push_str(" AND (src_dense_id, link_ord) > (?, ?)");
            params.extend([value(&after.source), value(&after.ordinal)]);
        }
        params.push(value(&limit));
        self.at_cut(
            scope,
            cut,
            filter,
            params,
            "ORDER BY src_dense_id, link_ord LIMIT ?",
        )
        .await
    }

    pub(crate) async fn graph_edges_page(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        address: Option<LinkAddress<'_>>,
        after: Option<(u32, u32)>,
        limit: u16,
    ) -> Result<Vec<(u32, u32, u32)>, PortError> {
        if limit == 0 || limit > 4_096 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let scope = scope.clone();
        let mut sql = String::from(
            "SELECT src_dense_id, link_ord, resolved_dense_id FROM projected_note_links \
             WHERE space_id = ? AND resolved_dense_id IS NOT NULL",
        );
        let mut params = vec![value(&scope.space_id)];
        match address {
            Some(LinkAddress::Source(source)) => {
                sql.push_str(" AND src_dense_id = ?");
                params.push(value(&source));
            }
            Some(LinkAddress::Target(target)) => {
                sql.push_str(" AND resolved_dense_id = ?");
                params.push(value(&target));
            }
            None => (),
            Some(_) => return Err(DomainError::validation(ValidationReason::InvalidQuery).into()),
        }
        if let Some((source, ordinal)) = after {
            sql.push_str(" AND (src_dense_id, link_ord) > (?, ?)");
            params.extend([value(&source), value(&ordinal)]);
        }
        sql.push_str(" ORDER BY src_dense_id, link_ord LIMIT ?");
        params.push(value(&limit));
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(not_ready)?;
                    assert_cut(&row, &scope, cut)?;
                    if row.projected_seq != cut {
                        return Err(super::stale());
                    }
                    tx.select(&sql, params, &[Kind::Integer; 3])
                        .await?
                        .into_iter()
                        .map(|mut row| {
                            let target = u32::read(row.pop().ok_or_else(invalid_row)?)?;
                            let ordinal = u32::read(row.pop().ok_or_else(invalid_row)?)?;
                            let source = u32::read(row.pop().ok_or_else(invalid_row)?)?;
                            Ok((source, ordinal, target))
                        })
                        .collect()
                })
            })
            .await
    }

    pub(crate) async fn link_page(
        &self,
        space: &SpaceId,
        address: LinkAddress<'_>,
        after: Option<&LinkPosition>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedLink>, PortError> {
        let mut filter = String::from("WHERE space_id = ?");
        let mut params = vec![value(space)];
        match address {
            LinkAddress::Leaf(leaf) => {
                filter.push_str(" AND leaf_norm_key = ?");
                params.push(value(&leaf.to_owned()));
            }
            LinkAddress::Target(dense) => {
                filter.push_str(" AND resolved_dense_id = ?");
                params.push(value(&dense));
            }
            LinkAddress::Prefix(prefix) => {
                return self.prefix_link_page(space, prefix, after, limit).await;
            }
            LinkAddress::RelativeSource(folder) => {
                filter.push_str(" AND uses_relative_prefix = 1 AND src_folder_id = ?");
                params.push(value(folder));
            }
            LinkAddress::Source(dense) => {
                filter.push_str(" AND src_dense_id = ?");
                params.push(value(&dense));
            }
        }
        if let Some(after) = after {
            filter.push_str(" AND (src_dense_id, link_ord) > (?, ?)");
            params.extend([value(&after.source), value(&after.ordinal)]);
        }
        filter.push_str(" ORDER BY src_dense_id, link_ord LIMIT ?");
        params.push(value(&i64::from(limit.get())));
        let rows = self.select_current(filter, params).await?;
        #[cfg(test)]
        if matches!(address, LinkAddress::Leaf(_) | LinkAddress::Target(_)) {
            self.reverse_link_reads
                .fetch_add(rows.len(), std::sync::atomic::Ordering::Relaxed);
        }
        Ok(rows)
    }

    /// Pages unresolved links and historical-alias links (tier >= 60) in
    /// `(src_dense_id, link_ord)` order so incremental purge recovery can
    /// re-resolve affected edges without re-reading canonical note carriers.
    pub(crate) async fn unresolved_or_alias_links_page(
        &self,
        space: &SpaceId,
        after: Option<&LinkPosition>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedLink>, PortError> {
        let mut filter = String::from(
            "WHERE space_id = ? AND (resolved_dense_id IS NULL OR resolved_tier >= 60)",
        );
        let mut params = vec![value(space)];
        if let Some(after) = after {
            filter.push_str(" AND (src_dense_id, link_ord) > (?, ?)");
            params.extend([value(&after.source), value(&after.ordinal)]);
        }
        filter.push_str(" ORDER BY src_dense_id, link_ord LIMIT ?");
        params.push(value(&i64::from(limit.get())));
        self.select_current(filter, params).await
    }

    async fn prefix_link_page(
        &self,
        space: &SpaceId,
        prefix: &str,
        after: Option<&LinkPosition>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedLink>, PortError> {
        let mut rows = Vec::new();
        if !prefix.is_empty() && after.is_none_or(|after| after.prefix == prefix) {
            let mut filter = String::from("WHERE space_id = ? AND dir_norm_prefix = ?");
            let mut params = vec![value(space), value(&prefix.to_owned())];
            if let Some(after) = after {
                filter.push_str(" AND (src_dense_id, link_ord) > (?, ?)");
                params.extend([value(&after.source), value(&after.ordinal)]);
            }
            filter.push_str(" ORDER BY src_dense_id, link_ord LIMIT ?");
            params.push(value(&limit.get()));
            rows = self.select_current(filter, params).await?;
            if rows.len() == usize::from(limit.get()) {
                return Ok(rows);
            }
        }
        let mut filter = String::from("WHERE space_id = ?");
        let mut params = vec![value(space)];
        let child_after = after.filter(|after| after.prefix != prefix);
        if prefix.is_empty() {
            if let Some(after) = child_after
                && !after.prefix.is_empty()
            {
                filter.push_str(" AND (dir_norm_prefix, src_dense_id, link_ord) > (?, ?, ?)");
                params.extend([
                    value(&after.prefix),
                    value(&after.source),
                    value(&after.ordinal),
                ]);
            } else {
                filter.push_str(" AND dir_norm_prefix > ''");
            }
        } else {
            // Both dialects use bytewise collation. Avoid redundant lower bounds
            // so the B-tree seeks directly to the cursor position.
            let lower = format!("{prefix}/");
            let upper = format!("{prefix}0");
            if let Some(after) = child_after
                && after.prefix >= lower
            {
                filter.push_str(
                    " AND dir_norm_prefix < ? AND (dir_norm_prefix, src_dense_id, link_ord) > (?, ?, ?)",
                );
                params.extend([
                    value(&upper),
                    value(&after.prefix),
                    value(&after.source),
                    value(&after.ordinal),
                ]);
            } else {
                filter.push_str(" AND dir_norm_prefix >= ? AND dir_norm_prefix < ?");
                params.extend([value(&lower), value(&upper)]);
            }
        }
        filter.push_str(" ORDER BY dir_norm_prefix, src_dense_id, link_ord LIMIT ?");
        let remaining = usize::from(limit.get()) - rows.len();
        params.push(value(&(remaining as u16)));
        rows.extend(self.select_current::<ProjectedLink>(filter, params).await?);
        Ok(rows)
    }

    pub(crate) async fn link_aliases_in_slot(
        &self,
        space: &SpaceId,
        parent: &FolderId,
        slug_fold: &str,
        after: Option<&NoteAliasPosition>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        // PK: (space_id, old_parent_folder_id, old_slug_fold, created_seq, target_note_id)
        let mut filter =
            String::from("WHERE space_id = ? AND old_parent_folder_id = ? AND old_slug_fold = ?");
        let mut params = vec![value(space), value(parent), value(&slug_fold.to_owned())];
        if let Some(after) = after {
            filter.push_str(" AND (created_seq, target_note_id) > (?, ?)");
            params.extend([value(&after.seq), value(&after.note)]);
        }
        filter.push_str(" ORDER BY created_seq, target_note_id LIMIT ?");
        params.push(value(&i64::from(limit.get())));
        self.select_current(filter, params).await
    }

    pub(crate) async fn link_aliases_for_note(
        &self,
        space: &SpaceId,
        note: &NoteId,
        after: Option<&NoteAliasPosition>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        // Index: projected_note_alias_target (space_id, target_note_id, old_parent_folder_id, old_slug_fold, created_seq)
        let mut filter = String::from("WHERE space_id = ? AND target_note_id = ?");
        let mut params = vec![value(space), value(note)];
        if let Some(after) = after {
            filter.push_str(" AND (old_parent_folder_id, old_slug_fold, created_seq) > (?, ?, ?)");
            params.extend([value(&after.parent), value(&after.slug), value(&after.seq)]);
        }
        filter.push_str(" ORDER BY old_parent_folder_id, old_slug_fold, created_seq LIMIT ?");
        params.push(value(&i64::from(limit.get())));
        self.select_current(filter, params).await
    }
}
