//! Private, command-scoped lookup rows for incremental link resolution.

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, SpaceId, SpaceSeq},
    model::Lifecycle,
};

use super::{
    CandidateLookupKey, DerivedStore, ProjectedLink, ProjectedNoteAlias, StageKey, invalid_row,
    not_ready,
    read::watermark,
    schema::read_space_guard,
    sql::{Kind, SqlColumn, SqlRecord, SqlTransaction, SqlValue, value},
    stale,
};
use crate::links::{
    AliasKey, CandidatePosition, CandidateQuery, NoteAliasPosition, ResolutionIndex,
};

const PAGE: usize = 200;

pub(super) const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS projection_link_scratch (
    id BLOB PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    history_incarnation BLOB NOT NULL,
    first_seq BIGINT NOT NULL,
    last_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS projection_link_scratch_space ON projection_link_scratch (space_id);
CREATE TABLE IF NOT EXISTS projection_link_seen_notes (
    scratch BLOB NOT NULL REFERENCES projection_link_scratch(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL,
    PRIMARY KEY (scratch, note_id)
);
CREATE TABLE IF NOT EXISTS projection_link_sources (
    scratch BLOB NOT NULL REFERENCES projection_link_scratch(id) ON DELETE CASCADE,
    dense_id BIGINT NOT NULL,
    note_id TEXT NOT NULL,
    parent TEXT,
    visible BIGINT NOT NULL,
    raw_count BIGINT,
    replace_candidates BIGINT NOT NULL,
    replace_slot BIGINT NOT NULL,
    slot_parent TEXT,
    slot_slug TEXT,
    PRIMARY KEY (scratch, dense_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS projection_link_sources_note ON projection_link_sources (scratch, note_id);
CREATE UNIQUE INDEX IF NOT EXISTS projection_link_slots ON projection_link_sources (scratch, slot_parent, slot_slug);
CREATE TABLE IF NOT EXISTS projection_link_raw (
    scratch BLOB NOT NULL REFERENCES projection_link_scratch(id) ON DELETE CASCADE,
    dense_id BIGINT NOT NULL,
    ordinal BIGINT NOT NULL,
    raw_target TEXT NOT NULL,
    PRIMARY KEY (scratch, dense_id, ordinal)
);
CREATE TABLE IF NOT EXISTS projection_link_candidate_scratch (
    scratch BLOB NOT NULL REFERENCES projection_link_scratch(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL,
    tier BIGINT NOT NULL,
    scope_folder_dense_id BIGINT NOT NULL,
    leaf_norm_key TEXT NOT NULL,
    target_dense_id BIGINT NOT NULL,
    target_note_id TEXT NOT NULL,
    created_at_sec BIGINT NOT NULL,
    created_at_nsec BIGINT NOT NULL,
    PRIMARY KEY (scratch, scope_folder_dense_id, leaf_norm_key, tier, created_at_sec, created_at_nsec, target_note_id)
);
CREATE INDEX IF NOT EXISTS projection_link_candidate_scratch_note
    ON projection_link_candidate_scratch (scratch, target_dense_id, tier, scope_folder_dense_id, leaf_norm_key);
CREATE TABLE IF NOT EXISTS projection_link_alias_scratch (
    scratch BLOB NOT NULL REFERENCES projection_link_scratch(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL,
    old_parent_folder_id TEXT NOT NULL,
    old_slug_fold TEXT NOT NULL,
    old_title_norm TEXT NOT NULL,
    created_seq BIGINT NOT NULL,
    target_note_id TEXT NOT NULL,
    PRIMARY KEY (scratch, old_parent_folder_id, old_slug_fold, created_seq, target_note_id)
);
CREATE INDEX IF NOT EXISTS projection_link_alias_scratch_slug ON projection_link_alias_scratch (scratch, old_slug_fold, old_parent_folder_id, created_seq, target_note_id);
CREATE INDEX IF NOT EXISTS projection_link_alias_scratch_title ON projection_link_alias_scratch (scratch, old_title_norm, old_parent_folder_id, old_slug_fold, created_seq, target_note_id);
CREATE TABLE IF NOT EXISTS projection_link_leaves (
    scratch BLOB NOT NULL REFERENCES projection_link_scratch(id) ON DELETE CASCADE,
    leaf TEXT NOT NULL,
    PRIMARY KEY (scratch, leaf)
);
CREATE TABLE IF NOT EXISTS projection_link_watch (
    scratch BLOB NOT NULL REFERENCES projection_link_scratch(id) ON DELETE CASCADE,
    source BIGINT NOT NULL,
    ordinal BIGINT NOT NULL,
    PRIMARY KEY (scratch, source, ordinal)
);
"#;

#[derive(Clone)]
struct ScratchKey {
    id: Vec<u8>,
    stage: StageKey,
    before: SpaceSeq,
}

pub(crate) struct LinkScratch {
    store: DerivedStore,
    key: ScratchKey,
    cleared: bool,
}

pub(crate) struct ScratchSource {
    pub dense: u32,
    pub note: NoteId,
    pub parent: Option<FolderId>,
    pub visible: bool,
    /// Missing means to retain authored targets from the preceding cut.
    pub raw_count: Option<u32>,
    pub replace_candidates: bool,
    pub replace_slot: bool,
    pub slot: Option<(FolderId, String)>,
}

impl LinkScratch {
    pub(crate) async fn open(
        store: &DerivedStore,
        stage: &StageKey,
        before: SpaceSeq,
    ) -> Result<Self, PortError> {
        if before.checked_next()? != stage.first || stage.first > stage.last {
            return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
        }
        let mut id = vec![0; 16];
        getrandom::fill(&mut id).map_err(|_| super::internal("projection_link_scratch_entropy"))?;
        let key = ScratchKey {
            id,
            stage: stage.clone(),
            before,
        };
        let open = key.clone();
        store.database.write(false, move |mut tx| Box::pin(async move {
            open.check_cut(&mut tx, true).await?;
            tx.execute(
                "INSERT INTO projection_link_scratch (id, space_id, history_incarnation, first_seq, last_seq)
                 VALUES (?, ?, ?, ?, ?)",
                vec![value(&open.id), value(&open.stage.scope.space_id), value(&open.stage.scope.incarnation),
                     value(&open.stage.first), value(&open.stage.last)],
            ).await?;
            Ok(())
        })).await?;
        Ok(Self {
            store: store.clone(),
            key,
            cleared: false,
        })
    }

    pub(crate) async fn first_note(&self, note: &NoteId) -> Result<bool, PortError> {
        let note = note.clone();
        let key = self.key.clone();
        self.store.database.write(false, move |mut tx| Box::pin(async move {
            key.check(&mut tx, true).await?;
            let changed = tx.execute(
                "INSERT INTO projection_link_seen_notes (scratch, note_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                vec![value(&key.id), value(&note)],
            ).await?;
            Ok(changed == 1)
        })).await
    }

    pub(crate) async fn record_source(&self, source: ScratchSource) -> Result<(), PortError> {
        let key = self.key.clone();
        self.store.database.write(false, move |mut tx| Box::pin(async move {
            key.check(&mut tx, true).await?;
            tx.execute(
                "INSERT INTO projection_link_sources
                 (scratch, dense_id, note_id, parent, visible, raw_count, replace_candidates, replace_slot, slot_parent, slot_slug)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                vec![value(&key.id), value(&source.dense), value(&source.note), value(&source.parent),
                     value(&source.visible), value(&source.raw_count), value(&source.replace_candidates),
                     value(&source.replace_slot), value(&source.slot.as_ref().map(|(parent, _)| parent.clone())),
                     value(&source.slot.map(|(_, slug)| slug))],
            ).await?;
            Ok(())
        })).await
    }

    pub(crate) async fn record_raw(
        &self,
        dense: u32,
        start: u32,
        rows: &[String],
    ) -> Result<(), PortError> {
        for (batch, raw) in rows.chunks(PAGE).enumerate() {
            let key = self.key.clone();
            let raw = raw.to_vec();
            let start = start
                .checked_add((batch * PAGE) as u32)
                .ok_or_else(invalid_row)?;
            self.store.database.write(false, move |mut tx| Box::pin(async move {
                key.check(&mut tx, true).await?;
                for (offset, raw) in raw.iter().enumerate() {
                    let ordinal = start.checked_add(offset as u32).ok_or_else(invalid_row)?;
                    tx.execute(
                        "INSERT INTO projection_link_raw (scratch, dense_id, ordinal, raw_target) VALUES (?, ?, ?, ?)",
                        vec![value(&key.id), value(&dense), value(&ordinal), value(raw)],
                    ).await?;
                }
                Ok(())
            })).await?;
        }
        Ok(())
    }

    pub(crate) async fn record_candidates(
        &self,
        rows: &[CandidateLookupKey],
    ) -> Result<(), PortError> {
        for rows in rows.chunks(PAGE) {
            let rows = rows.to_vec();
            let key = self.key.clone();
            self.store.database.write(false, move |mut tx| Box::pin(async move {
                key.check(&mut tx, true).await?;
                let sql = format!("INSERT INTO projection_link_candidate_scratch (scratch, {}) VALUES ({})",
                    CandidateLookupKey::columns(), super::sql::placeholders(CandidateLookupKey::COLUMNS.len() + 1));
                for row in rows {
                    let mut params = vec![value(&key.id)];
                    params.extend(row.values());
                    tx.execute(&sql, params).await?;
                }
                Ok(())
            })).await?;
        }
        Ok(())
    }

    pub(crate) async fn record_alias(&self, alias: &ProjectedNoteAlias) -> Result<(), PortError> {
        let key = self.key.clone();
        let alias = alias.clone();
        if alias.space_id != key.stage.scope.space_id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
        self.store.database.write(false, move |mut tx| Box::pin(async move {
            key.check(&mut tx, true).await?;
            let sql = format!(
                "INSERT INTO projection_link_alias_scratch (scratch, {}) VALUES ({}) ON CONFLICT DO NOTHING",
                ProjectedNoteAlias::columns(), super::sql::placeholders(ProjectedNoteAlias::COLUMNS.len() + 1),
            );
            let mut params = vec![value(&key.id)];
            params.extend(alias.values());
            tx.execute(&sql, params).await?;
            insert_leaves(&mut tx, &key.id, [alias.old_slug_fold, alias.old_title_norm]).await
        })).await
    }

    pub(crate) async fn record_leaves(&self, leaves: &[String]) -> Result<(), PortError> {
        for leaves in leaves.chunks(PAGE) {
            let key = self.key.clone();
            let leaves = leaves.to_vec();
            self.store
                .database
                .write(false, move |mut tx| {
                    Box::pin(async move {
                        key.check(&mut tx, true).await?;
                        insert_leaves(&mut tx, &key.id, leaves).await
                    })
                })
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn record_watch(&self, rows: &[ProjectedLink]) -> Result<(), PortError> {
        if rows.is_empty() {
            return Ok(());
        }
        let key = self.key.clone();
        let rows = rows
            .iter()
            .map(|row| (row.src_dense_id, row.link_ord))
            .collect::<Vec<_>>();
        self.store
            .database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    key.check(&mut tx, true).await?;
                    for (source, ordinal) in rows {
                        tx.execute(
                            "INSERT INTO projection_link_watch (scratch, source, ordinal)
                     SELECT ?, ?, ? WHERE NOT EXISTS (
                         SELECT 1 FROM projection_link_sources WHERE scratch = ? AND dense_id = ?
                     ) ON CONFLICT DO NOTHING",
                            vec![
                                value(&key.id),
                                value(&source),
                                value(&ordinal),
                                value(&key.id),
                                value(&source),
                            ],
                        )
                        .await?;
                    }
                    Ok(())
                })
            })
            .await
    }

    pub(crate) async fn sources(
        &self,
        after: Option<u32>,
    ) -> Result<Vec<ScratchSource>, PortError> {
        let key = self.key.clone();
        self.store.database.read(move |mut tx| Box::pin(async move {
            key.check(&mut tx, false).await?;
            tx.select(
                "SELECT dense_id, note_id, parent, visible, raw_count, replace_candidates, replace_slot, slot_parent, slot_slug
                 FROM projection_link_sources WHERE scratch = ? AND dense_id > ? ORDER BY dense_id LIMIT 200",
                vec![value(&key.id), value(&after.map_or(-1, i64::from))],
                &[Kind::Integer, Kind::Text, Kind::Text, Kind::Integer, Kind::Integer,
                  Kind::Integer, Kind::Integer, Kind::Text, Kind::Text],
            ).await?.into_iter().map(|row| {
                let mut row = row.into_iter();
                let dense = next(&mut row)?;
                let note = next(&mut row)?;
                let parent = next(&mut row)?;
                let visible = next(&mut row)?;
                let raw_count = next(&mut row)?;
                let replace_candidates = next(&mut row)?;
                let replace_slot = next(&mut row)?;
                let slot = next::<Option<FolderId>>(&mut row)?.zip(next::<Option<String>>(&mut row)?);
                Ok(ScratchSource { dense, note, parent, visible, raw_count, replace_candidates, replace_slot, slot })
            }).collect()
        })).await
    }

    pub(crate) async fn leaves(&self, after: Option<&str>) -> Result<Vec<String>, PortError> {
        let key = self.key.clone();
        let after = after.unwrap_or("").to_owned();
        self.store.database.read(move |mut tx| Box::pin(async move {
            key.check(&mut tx, false).await?;
            tx.select(
                "SELECT leaf FROM projection_link_leaves WHERE scratch = ? AND leaf > ? ORDER BY leaf LIMIT 200",
                vec![value(&key.id), value(&after)], &[Kind::Text],
            ).await?.into_iter().map(|row| next(&mut row.into_iter())).collect()
        })).await
    }

    pub(crate) async fn raw(&self, dense: u32, from: u32) -> Result<Vec<(u32, String)>, PortError> {
        let key = self.key.clone();
        self.store
            .database
            .read(move |mut tx| {
                Box::pin(async move {
                    key.check(&mut tx, false).await?;
                    tx.select(
                        "SELECT ordinal, raw_target FROM projection_link_raw
                 WHERE scratch = ? AND dense_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT 200",
                        vec![value(&key.id), value(&dense), value(&from)],
                        &[Kind::Integer, Kind::Text],
                    )
                    .await?
                    .into_iter()
                    .map(|row| {
                        let mut row = row.into_iter();
                        Ok((next(&mut row)?, next(&mut row)?))
                    })
                    .collect()
                })
            })
            .await
    }

    pub(crate) async fn replacement_candidates(
        &self,
        dense: u32,
        after: Option<&CandidateLookupKey>,
    ) -> Result<Vec<CandidateLookupKey>, PortError> {
        let key = self.key.clone();
        let mut sql = format!(
            "SELECT {} FROM projection_link_candidate_scratch
            WHERE scratch = ? AND target_dense_id = ?",
            CandidateLookupKey::columns()
        );
        let mut params = vec![value(&key.id), value(&dense)];
        if let Some(after) = after {
            sql.push_str(" AND (tier, scope_folder_dense_id, leaf_norm_key) > (?, ?, ?)");
            params.extend([
                value(&after.tier),
                value(&after.scope_folder_dense_id),
                value(&after.leaf_norm_key),
            ]);
        }
        sql.push_str(" ORDER BY tier, scope_folder_dense_id, leaf_norm_key LIMIT 200");
        self.store
            .database
            .read(move |mut tx| {
                Box::pin(async move {
                    key.check(&mut tx, false).await?;
                    tx.records(&sql, params).await
                })
            })
            .await
    }

    pub(crate) async fn watched(
        &self,
        after: Option<(u32, u32)>,
    ) -> Result<Vec<ProjectedLink>, PortError> {
        let key = self.key.clone();
        self.store.database.read(move |mut tx| Box::pin(async move {
            key.check(&mut tx, false).await?;
            let (source, ordinal) = after.map_or((-1, -1), |(s, o)| (i64::from(s), i64::from(o)));
            let columns = ProjectedLink::COLUMNS.iter().map(|col| format!("link.{}", col.name)).collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT {columns} FROM projection_link_watch AS watch
                 JOIN projected_note_links AS link ON link.space_id = ? AND link.src_dense_id = watch.source AND link.link_ord = watch.ordinal
                 WHERE watch.scratch = ? AND (watch.source, watch.ordinal) > (?, ?)
                 ORDER BY watch.source, watch.ordinal LIMIT 200"
            );
            tx.records(&sql, vec![value(&key.stage.scope.space_id), value(&key.id), value(&source), value(&ordinal)]).await
        })).await
    }

    pub(crate) async fn clear(mut self) -> Result<(), PortError> {
        clear(&self.store, self.key.id.clone()).await?;
        self.cleared = true;
        Ok(())
    }
}

impl Drop for LinkScratch {
    fn drop(&mut self) {
        if !self.cleared
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            let id = self.key.id.clone();
            let store = self.store.clone();
            handle.spawn(async move {
                let _ = clear(&store, id).await;
            });
        }
    }
}

impl ScratchKey {
    async fn check_cut(&self, tx: &mut SqlTransaction<'_>, write: bool) -> Result<(), PortError> {
        let guard = read_space_guard(tx, &self.stage.scope.space_id, write)
            .await?
            .ok_or_else(not_ready)?;
        if guard.incarnation != self.stage.scope.incarnation {
            return Err(super::mismatch());
        }
        if self.stage.last < guard.minimum_checkpoint_seq {
            return Err(stale());
        }
        let current = watermark(tx, &self.stage.scope.space_id)
            .await?
            .ok_or_else(not_ready)?;
        if current.history_incarnation != self.stage.scope.incarnation {
            return Err(super::mismatch());
        }
        if current.seed_in_progress || current.projected_seq != self.before {
            return Err(stale());
        }
        Ok(())
    }

    async fn check(&self, tx: &mut SqlTransaction<'_>, write: bool) -> Result<(), PortError> {
        self.check_cut(tx, write).await?;
        let exists = tx
            .select(
                "SELECT CAST(1 AS BIGINT) FROM projection_link_scratch WHERE id = ?",
                vec![value(&self.id)],
                &[Kind::Integer],
            )
            .await?;
        if exists.is_empty() {
            return Err(stale());
        }
        Ok(())
    }

    fn check_space(&self, space: &SpaceId) -> Result<(), PortError> {
        if self.stage.scope.space_id != *space {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
        Ok(())
    }
}

async fn insert_leaves(
    tx: &mut SqlTransaction<'_>,
    id: &Vec<u8>,
    leaves: impl IntoIterator<Item = String> + Send,
) -> Result<(), PortError> {
    for leaf in leaves
        .into_iter()
        .filter(|leaf| !leaf.is_empty())
        .collect::<Vec<_>>()
    {
        tx.execute(
            "INSERT INTO projection_link_leaves (scratch, leaf) VALUES (?, ?) ON CONFLICT DO NOTHING",
            vec![value(id), value(&leaf)],
        ).await?;
    }
    Ok(())
}

async fn clear(store: &DerivedStore, id: Vec<u8>) -> Result<(), PortError> {
    store
        .database
        .write(false, move |mut tx| {
            Box::pin(async move {
                tx.execute(
                    "DELETE FROM projection_link_scratch WHERE id = ?",
                    vec![value(&id)],
                )
                .await?;
                Ok(())
            })
        })
        .await
}

fn next<T: SqlColumn>(row: &mut std::vec::IntoIter<SqlValue>) -> Result<T, PortError> {
    T::read(row.next().ok_or_else(invalid_row)?)
}

impl ResolutionIndex for LinkScratch {
    async fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> Result<Vec<CandidateLookupKey>, PortError> {
        self.key.check_space(query.space)?;
        let key = self.key.clone();
        let mut criteria = String::from(
            "scope_folder_dense_id = ? AND leaf_norm_key = ? AND tier >= ? AND tier <= ?",
        );
        let mut params = vec![
            value(&query.folder),
            value(&query.leaf.to_owned()),
            value(&query.min_tier),
            value(&query.max_tier),
        ];
        if let Some(note) = query.exact_note {
            criteria.push_str(" AND target_note_id = ?");
            params.push(value(&note.to_owned()));
        }
        if let Some(after) = after {
            criteria.push_str(
                " AND (tier, created_at_sec, created_at_nsec, target_note_id) > (?, ?, ?, ?)",
            );
            params.extend([
                value(&after.tier),
                value(&after.created_at_sec),
                value(&after.created_at_nsec),
                value(&after.note),
            ]);
        }
        criteria
            .push_str(" ORDER BY tier, created_at_sec, created_at_nsec, target_note_id LIMIT ?");
        params.push(value(&limit));
        self.store.database.read(move |mut tx| Box::pin(async move {
            key.check(&mut tx, false).await?;
            let columns = CandidateLookupKey::columns();
            let scratch_sql = format!("SELECT {columns} FROM projection_link_candidate_scratch WHERE scratch = ? AND {criteria}");
            let mut scratch_args = vec![value(&key.id)];
            scratch_args.extend(params.clone());
            let mut rows: Vec<CandidateLookupKey> = tx.records(&scratch_sql, scratch_args).await?;
            let old_sql = format!("SELECT {columns} FROM candidate_lookup_keys AS candidate
                WHERE space_id = ? AND NOT EXISTS (
                   SELECT 1 FROM projection_link_sources AS changed
                   WHERE changed.scratch = ? AND changed.dense_id = candidate.target_dense_id
                   AND changed.replace_candidates = 1
                ) AND {criteria}");
            let mut old_args = vec![value(&key.stage.scope.space_id), value(&key.id)];
            old_args.extend(params);
            rows.extend(tx.records::<CandidateLookupKey>(&old_sql, old_args).await?);
            rows.sort_by_key(|row| CandidatePosition::from(row));
            rows.truncate(usize::from(limit));
            Ok(rows)
        })).await
    }

    async fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        self.key.check_space(space)?;
        let key = self.key.clone();
        let mut criteria = match selector {
            AliasKey::Slug => "old_slug_fold = ?".to_owned(),
            AliasKey::Title => "old_title_norm = ?".to_owned(),
        };
        let mut params = vec![value(&leaf.to_owned())];
        if let Some(after) = after {
            criteria.push_str(" AND (old_parent_folder_id, old_slug_fold, created_seq, target_note_id) > (?, ?, ?, ?)");
            params.extend([
                value(&after.parent),
                value(&after.slug),
                value(&after.seq),
                value(&after.note),
            ]);
        }
        criteria.push_str(
            " ORDER BY old_parent_folder_id, old_slug_fold, created_seq, target_note_id LIMIT ?",
        );
        params.push(value(&limit));
        self.store.database.read(move |mut tx| Box::pin(async move {
            key.check(&mut tx, false).await?;
            let columns = ProjectedNoteAlias::columns();
            let scratch_sql = format!("SELECT {columns} FROM projection_link_alias_scratch WHERE scratch = ? AND {criteria}");
            let mut scratch_args = vec![value(&key.id)];
            scratch_args.extend(params.clone());
            let mut rows: Vec<ProjectedNoteAlias> = tx.records(&scratch_sql, scratch_args).await?;
            let old_sql = format!("SELECT {columns} FROM projected_note_aliases WHERE space_id = ? AND {criteria}");
            let mut old_args = vec![value(&key.stage.scope.space_id)];
            old_args.extend(params);
            rows.extend(tx.records::<ProjectedNoteAlias>(&old_sql, old_args).await?);
            rows.sort_by_key(|row| NoteAliasPosition::from(row));
            rows.dedup_by(|left, right| NoteAliasPosition::from(&*left) == NoteAliasPosition::from(&*right));
            rows.truncate(usize::from(limit));
            Ok(rows)
        })).await
    }

    async fn slot_occupant(
        &self,
        space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> Result<Option<NoteId>, PortError> {
        self.key.check_space(space)?;
        let key = self.key.clone();
        let parent = parent.clone();
        let slug = slug.to_owned();
        self.store.database.read(move |mut tx| Box::pin(async move {
            key.check(&mut tx, false).await?;
            let sql = "SELECT note_id FROM projection_link_sources WHERE scratch = ? AND slot_parent = ? AND slot_slug = ?
                UNION ALL
                SELECT note_id FROM projected_notes AS note WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ?
                AND lifecycle = ? AND NOT EXISTS (
                    SELECT 1 FROM projection_link_sources AS changed
                    WHERE changed.scratch = ? AND changed.note_id = note.note_id AND changed.replace_slot = 1
                ) LIMIT 2";
            let mut rows = tx.select(sql,
                vec![value(&key.id), value(&parent), value(&slug), value(&key.stage.scope.space_id),
                     value(&parent), value(&slug), value(&Lifecycle::Active), value(&key.id)],
                &[Kind::Text],
            ).await?;
            if rows.len() > 1 { return Err(invalid_row()); }
            rows.pop().map(|row| next(&mut row.into_iter())).transpose()
        })).await
    }
}
