use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{AbilityId, ContentDigest, FolderId, HistoryIncarnation, NoteId, RevisionId, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::PageLimit,
};

use super::{
    DerivedStore, invalid_row, mismatch, not_ready,
    read::{assert_cut, watermark},
    sql::{Kind, SqlColumn, SqlValue, pad_sqlite_in, placeholders, value},
};

#[derive(Clone)]
pub(crate) struct ListCardRow {
    pub space_id: notarium_core::ids::SpaceId,
    pub note_id: NoteId,
    pub rev_id: RevisionId,
    pub parent_folder_id: FolderId,
    pub ability_id: Option<AbilityId>,
    pub doc_class: DocClass,
    pub lifecycle: Lifecycle,
    pub content_digest: Option<ContentDigest>,
    pub title: String,
    pub slug: String,
}

#[derive(Clone)]
pub(crate) struct CurrentCard {
    pub note: NoteId,
    pub revision: RevisionId,
    pub class: DocClass,
    pub lifecycle: Lifecycle,
    pub digest: ContentDigest,
    pub title: String,
    pub path: String,
    pub preview: String,
}

impl DerivedStore {
    /// One narrow SELECT checks the active cut and hydrates its current card
    /// rows and projected folder paths. None requests historical fallback.
    pub(crate) async fn hydrate_current_cards(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        ids: &[u32],
    ) -> Result<Option<Vec<Option<CurrentCard>>>, PortError> {
        if ids.is_empty() {
            return Ok(Some(Vec::new()));
        }
        PageLimit::new(
            u16::try_from(ids.len())
                .map_err(|_| DomainError::validation(ValidationReason::InvalidLimit))?,
        )?;
        let ids = ids.to_vec();
        let space = scope.space_id.clone();
        let incarnation = scope.incarnation;
        let kinds = [
            Kind::Bytes,
            Kind::Integer,
            Kind::Integer,
            Kind::Integer,
            Kind::Text,
            Kind::Text,
            Kind::Text,
            Kind::Text,
            Kind::Bytes,
            Kind::Text,
            Kind::Text,
            Kind::Text,
            Kind::Text,
        ];
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let rows = if tx.postgres() {
                        let sql = "SELECT w.history_incarnation, w.projected_seq, w.seed_in_progress,
                                    n.dense_id, n.note_id, n.rev_id, n.doc_class, n.lifecycle, n.content_digest,
                                    n.title, n.slug, n.preview, f.display_path_prefix
                             FROM space_projection_watermarks AS w
                             LEFT JOIN projected_notes AS n ON n.space_id = w.space_id AND n.dense_id = ANY(?)
                             LEFT JOIN projected_folders AS f ON f.space_id = n.space_id AND f.folder_id = n.parent_folder_id
                             WHERE w.space_id = ?";
                        let pg_ids = ids.iter().map(|&id| i64::from(id)).collect();
                        tx.select(sql, vec![SqlValue::IntArray(pg_ids), value(&space)], &kinds)
                            .await?
                    } else {
                        let padded = pad_sqlite_in(&ids);
                        let sql = format!(
                            "SELECT w.history_incarnation, w.projected_seq, w.seed_in_progress,
                                    n.dense_id, n.note_id, n.rev_id, n.doc_class, n.lifecycle, n.content_digest,
                                    n.title, n.slug, n.preview, f.display_path_prefix
                             FROM space_projection_watermarks AS w
                             LEFT JOIN projected_notes AS n ON n.space_id = w.space_id AND n.dense_id IN ({})
                             LEFT JOIN projected_folders AS f ON f.space_id = n.space_id AND f.folder_id = n.parent_folder_id
                             WHERE w.space_id = ?",
                            placeholders(padded.len()),
                        );
                        let params = padded
                            .iter()
                            .map(value)
                            .chain(std::iter::once(value(&space)))
                            .collect();
                        tx.select(&sql, params, &kinds).await?
                    };
                    if rows.is_empty() {
                        return Err(not_ready());
                    }
                    let mut cards = BTreeMap::new();
                    for row in rows {
                        let mut columns = row.into_iter();
                        if take::<HistoryIncarnation>(&mut columns)? != incarnation {
                            return Err(mismatch());
                        }
                        let actual = take::<SpaceSeq>(&mut columns)?;
                        if take::<bool>(&mut columns)? || actual < cut {
                            return Err(not_ready());
                        }
                        if actual > cut {
                            return Ok(None);
                        }
                        let Some(dense) = take::<Option<u32>>(&mut columns)? else {
                            continue;
                        };
                        let note = take(&mut columns)?;
                        let revision = take(&mut columns)?;
                        let class = take(&mut columns)?;
                        let lifecycle = take(&mut columns)?;
                        let Some(digest) = take::<Option<ContentDigest>>(&mut columns)? else {
                            continue;
                        };
                        let title = take(&mut columns)?;
                        let slug = take::<String>(&mut columns)?;
                        let preview = take(&mut columns)?;
                        let prefix =
                            take::<Option<String>>(&mut columns)?.ok_or_else(invalid_row)?;
                        let path = if prefix.is_empty() {
                            format!("{slug}.md")
                        } else {
                            format!("{prefix}/{slug}.md")
                        };
                        if cards
                            .insert(
                                dense,
                                CurrentCard {
                                    note,
                                    revision,
                                    class,
                                    lifecycle,
                                    digest,
                                    title,
                                    path,
                                    preview,
                                },
                            )
                            .is_some()
                        {
                            return Err(invalid_row());
                        }
                    }
                    Ok(Some(
                        ids.iter().map(|dense| cards.get(dense).cloned()).collect(),
                    ))
                })
            })
            .await
    }

    /// Narrow hydration for `list_notes`: avoids reading preview and all six
    /// MessagePack blobs (`tags`, `views`, `raw`, `evaluated`, `diagnostics`).
    pub(crate) async fn hydrate_list_rows(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        ids: &[u32],
    ) -> Result<Vec<Option<ListCardRow>>, PortError> {
        if ids.is_empty() {
            self.check_cut(scope, cut).await?;
            return Ok(Vec::new());
        }
        PageLimit::new(
            u16::try_from(ids.len())
                .map_err(|_| DomainError::validation(ValidationReason::InvalidLimit))?,
        )?;
        let scope = scope.clone();
        let req_ids = ids.to_vec();
        let kinds = [
            Kind::Integer,
            Kind::Text,
            Kind::Text,
            Kind::Text,
            Kind::Text,
            Kind::Text,
            Kind::Text,
            Kind::Bytes,
            Kind::Text,
            Kind::Text,
        ];
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(not_ready)?;
                    assert_cut(&row, &scope, cut)?;
                    let rows = if tx.postgres() {
                        let pg_ids = req_ids.iter().map(|&id| i64::from(id)).collect();
                        tx.select(
                            "SELECT dense_id, note_id, rev_id, parent_folder_id, ability_id,
                                    doc_class, lifecycle, content_digest, title, slug
                             FROM projected_notes
                             WHERE space_id = ? AND dense_id = ANY(?)",
                            vec![value(&scope.space_id), SqlValue::IntArray(pg_ids)],
                            &kinds,
                        )
                        .await?
                    } else {
                        let padded = pad_sqlite_in(&req_ids);
                        let sql = format!(
                            "SELECT dense_id, note_id, rev_id, parent_folder_id, ability_id,
                                    doc_class, lifecycle, content_digest, title, slug
                             FROM projected_notes
                             WHERE space_id = ? AND dense_id IN ({})",
                            placeholders(padded.len()),
                        );
                        let mut params = Vec::with_capacity(1 + padded.len());
                        params.push(value(&scope.space_id));
                        params.extend(padded.iter().map(value));
                        tx.select(&sql, params, &kinds).await?
                    };
                    let mut map = BTreeMap::new();
                    for raw in rows {
                        let mut cols = raw.into_iter();
                        let dense_id = take::<u32>(&mut cols)?;
                        map.insert(
                            dense_id,
                            ListCardRow {
                                space_id: scope.space_id.clone(),
                                note_id: take(&mut cols)?,
                                rev_id: take(&mut cols)?,
                                parent_folder_id: take(&mut cols)?,
                                ability_id: take(&mut cols)?,
                                doc_class: take(&mut cols)?,
                                lifecycle: take(&mut cols)?,
                                content_digest: take(&mut cols)?,
                                title: take(&mut cols)?,
                                slug: take(&mut cols)?,
                            },
                        );
                    }
                    Ok(req_ids.iter().map(|id| map.get(id).cloned()).collect())
                })
            })
            .await
    }
}

fn take<T: SqlColumn>(values: &mut std::vec::IntoIter<SqlValue>) -> Result<T, PortError> {
    T::read(values.next().ok_or_else(invalid_row)?)
}
