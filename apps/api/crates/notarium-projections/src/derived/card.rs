use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, HistoryIncarnation, NoteId, RevisionId, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::PageLimit,
};

use super::{
    DerivedStore, invalid_row, mismatch, not_ready,
    sql::{Kind, SqlColumn, SqlValue, placeholders, value},
};

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
        let sql = format!(
            "SELECT w.history_incarnation, w.projected_seq, w.seed_in_progress,
                    n.dense_id, n.note_id, n.rev_id, n.doc_class, n.lifecycle, n.content_digest,
                    n.title, n.slug, n.preview, f.display_path_prefix
             FROM space_projection_watermarks AS w
             LEFT JOIN projected_notes AS n ON n.space_id = w.space_id AND n.dense_id IN ({})
             LEFT JOIN projected_folders AS f ON f.space_id = n.space_id AND f.folder_id = n.parent_folder_id
             WHERE w.space_id = ?",
            placeholders(ids.len()),
        );
        let params = ids
            .iter()
            .map(value)
            .chain(std::iter::once(value(&space)))
            .collect();
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
                    let rows = tx.select(&sql, params, &kinds).await?;
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
}

fn take<T: SqlColumn>(values: &mut std::vec::IntoIter<SqlValue>) -> Result<T, PortError> {
    T::read(values.next().ok_or_else(invalid_row)?)
}
