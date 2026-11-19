use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ChatThreadId, FolderId, NoteId, SpaceId, SpaceSeq, ThreadEntrySeq},
    model::HistoryScope,
    ports::{PageLimit, ViewRef},
};

use super::{
    DerivedStore, invalid_row, mismatch, not_ready,
    records::*,
    sql::{SqlRecord, SqlTransaction, SqlValue, placeholders, value},
    stale,
};

impl DerivedStore {
    pub async fn watermarks(
        &self,
        space: &SpaceId,
    ) -> Result<Option<ProjectionWatermark>, PortError> {
        let space = space.clone();
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    watermark(&mut tx, &space)
                        .await?
                        .map(WatermarkRecord::watermark)
                        .transpose()
                })
            })
            .await
    }

    pub async fn schema_at(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
    ) -> Result<Option<ProjectionSchema>, PortError> {
        Ok(self
            .temporal::<SchemaRecord>(scope, cut, "1 = 1", Vec::new(), "")
            .await?
            .pop()
            .map(|row| ProjectionSchema {
                revision: row.revision,
                fingerprint: row.fingerprint,
                fields_msgpack: row.fields_msgpack,
            }))
    }

    pub async fn hydrate(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        dense_ids: &[u32],
    ) -> Result<Vec<Option<ProjectedNote>>, PortError> {
        if dense_ids.is_empty() {
            self.check_cut(scope, cut).await?;
            return Ok(Vec::new());
        }
        check_batch(dense_ids.len())?;
        let filter = format!("dense_id IN ({})", placeholders(dense_ids.len()));
        let rows = self
            .temporal::<ProjectedNote>(
                scope,
                cut,
                filter,
                dense_ids.iter().map(value).collect(),
                "",
            )
            .await?;
        Ok(in_request_order(dense_ids, rows, |row| row.dense_id))
    }

    pub async fn hydrate_folders(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        folder_ids: &[FolderId],
    ) -> Result<BTreeMap<FolderId, ProjectedFolder>, PortError> {
        if folder_ids.is_empty() {
            self.check_cut(scope, cut).await?;
            return Ok(BTreeMap::new());
        }
        check_batch(folder_ids.len())?;
        let filter = format!("folder_id IN ({})", placeholders(folder_ids.len()));
        Ok(self
            .temporal::<ProjectedFolder>(
                scope,
                cut,
                filter,
                folder_ids.iter().map(value).collect(),
                "",
            )
            .await?
            .into_iter()
            .map(|row| (row.folder_id.clone(), row))
            .collect())
    }

    pub async fn notes_page(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        after: Option<u32>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedNote>, PortError> {
        self.dense_page(scope, cut, "dense_id", after, limit).await
    }

    pub async fn folders_page(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        after: Option<u32>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedFolder>, PortError> {
        self.dense_page(scope, cut, "dense_folder_id", after, limit)
            .await
    }

    pub async fn folder_alias_page(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        after: Option<&ProjectedFolderAlias>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedFolderAlias>, PortError> {
        let mut args = Vec::new();
        let filter = if let Some(alias) = after {
            if alias.space_id != scope.space_id {
                return Err(DomainError::validation(ValidationReason::CursorScopeMismatch).into());
            }
            args.extend([
                value(&alias.old_parent_folder_id),
                value(&alias.old_slug_fold),
                value(&alias.created_seq),
                value(&alias.target_folder_id),
            ]);
            "(old_parent_folder_id, old_slug_fold, created_seq, target_folder_id) > (?, ?, ?, ?)"
        } else {
            "1 = 1"
        };
        args.push(value(&limit.get()));
        self.temporal(
            scope,
            cut,
            filter,
            args,
            "ORDER BY old_parent_folder_id, old_slug_fold, created_seq, target_folder_id LIMIT ?",
        )
        .await
    }

    async fn dense_page<R: SqlRecord + Send + 'static>(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        id: &'static str,
        after: Option<u32>,
        limit: PageLimit,
    ) -> Result<Vec<R>, PortError> {
        let filter = format!("{id} > ?");
        let suffix = format!("ORDER BY {id} ASC LIMIT ?");
        let after = after.map_or(-1, i64::from);
        self.temporal(
            scope,
            cut,
            filter,
            vec![value(&after), value(&limit.get())],
            suffix,
        )
        .await
    }

    pub async fn note_by_id(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        note: &NoteId,
    ) -> Result<Option<ProjectedNote>, PortError> {
        Ok(self
            .temporal(scope, cut, "note_id = ?", vec![value(note)], "")
            .await?
            .pop())
    }

    pub async fn folder_by_id(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        folder: &FolderId,
    ) -> Result<Option<ProjectedFolder>, PortError> {
        Ok(self
            .temporal(scope, cut, "folder_id = ?", vec![value(folder)], "")
            .await?
            .pop())
    }

    pub async fn view_descriptor(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        view: &ViewRef,
    ) -> Result<Option<ProjectedViewDescriptor>, PortError> {
        Ok(self
            .temporal(
                scope,
                cut,
                "view_note_id = ? AND view_key = ?",
                vec![value(&view.note), value(&view.key)],
                "",
            )
            .await?
            .pop())
    }

    pub async fn view_rank_page(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        view: &ViewRef,
        after: Option<&NoteId>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedViewRank>, PortError> {
        let mut params = vec![value(&view.note), value(&view.key)];
        let filter = if let Some(after) = after {
            params.push(value(after));
            "view_note_id = ? AND view_key = ? AND target_note_id > ?"
        } else {
            "view_note_id = ? AND view_key = ?"
        };
        params.push(value(&limit.get()));
        self.temporal(
            scope,
            cut,
            filter,
            params,
            "ORDER BY target_note_id ASC LIMIT ?",
        )
        .await
    }

    pub async fn chat_ref_page(
        &self,
        scope: &HistoryScope,
        target: &NoteId,
        after: Option<(&SpaceId, &ChatThreadId, ThreadEntrySeq)>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectedChatRef>, PortError> {
        let scope = scope.clone();
        let mut params = vec![
            value(&scope.space_id),
            value(&scope.incarnation),
            value(target),
        ];
        let mut filter =
            String::from("target_space_id = ? AND target_incarnation = ? AND target_note_id = ?");
        if let Some((space, thread, entry)) = after {
            filter.push_str(" AND (thread_space_id, thread_id, entry_seq) > (?, ?, ?)");
            params.extend([value(space), value(thread), value(&entry)]);
        }
        params.push(value(&limit.get()));
        let columns = ProjectedChatRef::columns();
        let sql = format!(
            "SELECT {columns} FROM chat_note_refs WHERE {filter}
            ORDER BY thread_space_id, thread_id, entry_seq LIMIT ?"
        );
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(not_ready)?;
                    assert_cut(&row, &scope, row.projected_seq)?;
                    tx.records(&sql, params).await
                })
            })
            .await
    }

    pub async fn chat_thread(
        &self,
        scope: &HistoryScope,
        thread: &ChatThreadId,
    ) -> Result<Option<ProjectedChatThread>, PortError> {
        let scope = scope.clone();
        let params = vec![value(&scope.space_id), value(thread)];
        let cols = ProjectedChatThread::columns();
        let sql = format!(
            "SELECT {cols} FROM projected_chat_threads WHERE space_id = ? AND thread_id = ?"
        );
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(not_ready)?;
                    assert_cut(&row, &scope, row.projected_seq)?;
                    Ok(tx.records(&sql, params).await?.pop())
                })
            })
            .await
    }

    pub async fn latest_trusted_checkpoint(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
    ) -> Result<Option<TrustedCheckpoint>, PortError> {
        Ok(self
            .select_current::<TrustedCheckpoint>(
                "WHERE space_id = ? AND history_incarnation = ? AND seq = ?
              ORDER BY format_version DESC, platform_abi, publication_id LIMIT 1",
                vec![
                    value(&scope.space_id),
                    value(&scope.incarnation),
                    value(&seq),
                ],
            )
            .await?
            .pop())
    }

    pub(crate) async fn trusted_checkpoint(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
        format_version: u32,
        platform_abi: &str,
        publication_id: &str,
    ) -> Result<Option<TrustedCheckpoint>, PortError> {
        let values = vec![
            value(&scope.space_id),
            value(&scope.incarnation),
            value(&seq),
            value(&format_version),
            value(&platform_abi.to_owned()),
            value(&publication_id.to_owned()),
        ];
        Ok(self
            .select_current::<TrustedCheckpoint>(
                "WHERE space_id = ? AND history_incarnation = ? AND seq = ?
             AND format_version = ? AND platform_abi = ? AND publication_id = ?",
                values,
            )
            .await?
            .pop())
    }

    pub(super) async fn select_current<R: SqlRecord + Send + 'static>(
        &self,
        filter: impl Into<String>,
        params: Vec<SqlValue>,
    ) -> Result<Vec<R>, PortError> {
        let columns = R::columns();
        let table = R::TABLE;
        let filter = filter.into();
        let sql = format!("SELECT {columns} FROM {table} {filter}");
        self.database
            .read(move |mut tx| Box::pin(async move { tx.records(&sql, params).await }))
            .await
    }

    pub(super) async fn check_cut(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(not_ready)?;
                    assert_cut(&row, &scope, cut)
                })
            })
            .await
    }

    pub(super) async fn temporal<R: SqlRecord + Send + 'static>(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        filter: impl Into<String>,
        params: Vec<SqlValue>,
        suffix: impl Into<String>,
    ) -> Result<Vec<R>, PortError> {
        let scope = scope.clone();
        let filter = filter.into();
        let suffix = suffix.into();
        self.database.read(move |mut tx| Box::pin(async move {
            let row = watermark(&mut tx, &scope.space_id).await?.ok_or_else(not_ready)?;
            assert_cut(&row, &scope, cut)?;
            let cols = R::columns();
            let table = R::TABLE;
            let mut args = vec![value(&scope.space_id)];
            if cut == row.projected_seq {
                args.extend(params);
                let sql = format!("SELECT {cols} FROM {table} WHERE space_id = ? AND ({filter}) {suffix}");
                return tx.records(&sql, args).await;
            }
            if !R::TEMPORAL {
                return Err(stale());
            }
            let history = R::history_table();
            let sql = format!(
                "SELECT {cols} FROM (
                     SELECT {cols} FROM {table} WHERE space_id = ? AND begin_seq <= ?
                     UNION ALL
                     SELECT {cols} FROM {history} WHERE space_id = ? AND begin_seq <= ? AND end_seq > ?
                 ) AS visible_rows WHERE ({filter}) {suffix}"
            );
            args.extend([value(&cut), value(&scope.space_id), value(&cut), value(&cut)]);
            args.extend(params);
            tx.records(&sql, args).await
        })).await
    }
}

pub(super) async fn watermark(
    tx: &mut SqlTransaction<'_>,
    space: &SpaceId,
) -> Result<Option<WatermarkRecord>, PortError> {
    let table = WatermarkRecord::TABLE;
    let columns = WatermarkRecord::columns();
    let sql = format!("SELECT {columns} FROM {table} WHERE space_id = ?");
    let mut rows = tx.records(&sql, vec![value(space)]).await?;
    if rows.len() > 1 {
        return Err(invalid_row());
    }
    Ok(rows.pop())
}

pub(super) fn assert_cut(
    row: &WatermarkRecord,
    scope: &HistoryScope,
    cut: SpaceSeq,
) -> Result<(), PortError> {
    if row.history_incarnation != scope.incarnation {
        return Err(mismatch());
    }
    if row.seed_in_progress || cut > row.projected_seq {
        return Err(not_ready());
    }
    if cut < row.retained_floor_seq {
        return Err(stale());
    }
    Ok(())
}

fn check_batch(size: usize) -> Result<(), PortError> {
    if size > usize::from(PageLimit::new(200).expect("maximum page size").get()) {
        Err(DomainError::validation(ValidationReason::InvalidLimit).into())
    } else {
        Ok(())
    }
}

impl DerivedStore {
    pub async fn folder_by_path(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        normalized_path: &str,
    ) -> Result<Option<ProjectedFolder>, PortError> {
        let mut rows = self
            .temporal::<ProjectedFolder>(
                scope,
                cut,
                "norm_path_prefix = ?",
                vec![value(&normalized_path.to_owned())],
                "LIMIT 2",
            )
            .await?;
        if rows.len() > 1 {
            return Err(invalid_row());
        }
        Ok(rows.pop())
    }

    /// Reads only the metadata needed to compare candidates at a retained cut.
    pub async fn hydrate_query_rows(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        dense_ids: &[u32],
    ) -> Result<Vec<Option<ProjectedQueryRow>>, PortError> {
        if dense_ids.is_empty() {
            self.check_cut(scope, cut).await?;
            return Ok(Vec::new());
        }
        check_batch(dense_ids.len())?;
        let filter = format!("dense_id IN ({})", placeholders(dense_ids.len()));
        let rows = self
            .temporal::<ProjectedQueryRow>(
                scope,
                cut,
                filter,
                dense_ids.iter().map(value).collect(),
                "",
            )
            .await?;
        Ok(in_request_order(dense_ids, rows, |row| row.dense_id))
    }
}

fn in_request_order<R: Clone>(
    ids: &[u32],
    rows: Vec<R>,
    dense: impl Fn(&R) -> u32,
) -> Vec<Option<R>> {
    // Preserve empty slots and duplicate IDs. Transfer each row into its last
    // position so a normal hydration never copies its card or field payload.
    let last_positions: BTreeMap<_, _> =
        ids.iter().enumerate().map(|(pos, id)| (id, pos)).collect();
    let mut rows: BTreeMap<_, _> = rows.into_iter().map(|row| (dense(&row), row)).collect();
    ids.iter()
        .enumerate()
        .map(|(position, id)| {
            if last_positions[id] == position {
                rows.remove(id)
            } else {
                rows.get(id).cloned()
            }
        })
        .collect()
}
