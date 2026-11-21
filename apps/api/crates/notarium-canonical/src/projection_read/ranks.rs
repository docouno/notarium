use std::collections::{BTreeSet, HashMap};

use notarium_core::{
    error::PortError,
    ids::{AgentRunId, NoteId, PrincipalId, RevisionId, SpaceSeq, ViewKey},
    model::HistoryScope,
    ports::{MaintenanceContext, PageLimit},
};

use crate::{
    CanonicalStore,
    codec::{
        MAX_MSGPACK_DECODE_BYTES, RankRevisionMetadata, RevisionMetadataEnvelope,
        RevisionMetadataPayload, decode_msgpack_bounded, i64_to_space_seq, internal_not_committed,
    },
    runtime::{pg_read_error, purge_fenced_note_ids_tx},
    sql_exec::BackendConn,
};

use super::{ProjectionPage, checked_cut, corrupt, page_next, stale, truncate_page};

pub type ProjectionRankKey = (NoteId, ViewKey, NoteId);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionRank {
    pub metadata: RankRevisionMetadata,
    pub revision_id: RevisionId,
    pub visibility_seq: SpaceSeq,
}

impl ProjectionRank {
    pub fn key(&self) -> ProjectionRankKey {
        (
            self.metadata.view_note_id.clone(),
            self.metadata.view_key.clone(),
            self.metadata.target_note_id.clone(),
        )
    }
}

impl CanonicalStore {
    /// Lists live ranks from the verified migration anchor and subsequent revisions.
    pub async fn read_projection_overlays_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        after: Option<ProjectionRankKey>,
        limit: PageLimit,
    ) -> Result<ProjectionPage<ProjectionRank, ProjectionRankKey>, PortError> {
        let scope = scope.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                checked_cut(tx, &scope, cutoff).await?;
                let anchor = rank_anchor(tx, &scope).await?;
                if cutoff < anchor {
                    return Err(stale());
                }
                let mut keys =
                    rank_keys(tx, &scope, anchor, cutoff, after.as_ref(), None, limit).await?;
                let more = truncate_page(&mut keys, limit);
                let next = page_next(&keys, more, Clone::clone);
                let rows = ranks_at_batch(tx, &scope, anchor, cutoff, keys).await?;
                Ok(ProjectionPage { rows, next })
            })
        })
        .await
    }
}

pub(super) async fn rank_anchor(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
) -> Result<SpaceSeq, PortError> {
    const SQL: &str = "SELECT history_incarnation, anchor_seq
        FROM projection_rank_anchors WHERE space_id = $1";
    let marker = read_rows!(
        tx,
        fetch_optional,
        "projection_rank_anchor",
        (Vec<u8>, i64),
        SQL,
        scope.space_id.as_str(),
    )?;
    match marker {
        Some((history, seq)) if history.as_slice() == scope.incarnation.as_bytes() => {
            Ok(i64_to_space_seq(seq)?)
        }
        Some(_) => Err(stale()),
        None => Ok(SpaceSeq::ZERO),
    }
}

pub(super) async fn target_ranks(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    anchor: SpaceSeq,
    cutoff: SpaceSeq,
    target: &NoteId,
) -> Result<Option<Vec<ProjectionRank>>, PortError> {
    let limit = PageLimit::new(200)?;
    let keys = rank_keys(tx, scope, anchor, cutoff, None, Some(target), limit).await?;
    if keys.len() > usize::from(limit.get()) {
        return Ok(None);
    }
    let rows = ranks_at_batch(tx, scope, anchor, cutoff, keys).await?;
    Ok(Some(rows))
}

// The delimiter sorts before every valid branded identifier byte. Replacing
// colons allows a single index range seek in the same order as the rank tuple,
// even when a legacy ID is a prefix of a longer ID.
const KEY_SEPARATOR: char = '\x1f';

macro_rules! sqlite_rank_key {
    () => {
        "replace(entity_key, ':', char(31))"
    };
}

macro_rules! postgres_rank_key {
    () => {
        "replace(entity_key, ':', chr(31)) COLLATE \"C\""
    };
}

macro_rules! revision_keys_query {
    ($key:ident, $index:literal, $predicate:expr $(,)?) => {
        concat!(
            "SELECT ",
            $key!(),
            " AS folded_key FROM revisions",
            $index,
            " WHERE space_id = $1 AND history_incarnation = $2 AND entity_type = 'rank'
                AND visibility_seq > $3 AND visibility_seq <= $4 AND ",
            $predicate,
            " GROUP BY folded_key ORDER BY folded_key LIMIT $6",
        )
    };
}

type RankKeyRow = (String, String, String);

async fn rank_keys(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    anchor: SpaceSeq,
    cutoff: SpaceSeq,
    after: Option<&ProjectionRankKey>,
    by_target: Option<&NoteId>,
    limit: PageLimit,
) -> Result<Vec<ProjectionRankKey>, PortError> {
    let maximum = i64::from(limit.get()) + 1;
    let space = scope.space_id.as_str();
    let after = after.map_or(("", "", ""), |(view, key, target)| {
        (view.as_str(), key.as_str(), target.as_str())
    });

    let anchors = if anchor == SpaceSeq::ZERO {
        Vec::new()
    } else if let Some(target) = by_target {
        const SQL: &str = "SELECT view_note_id, view_key, target_note_id
            FROM projection_rank_anchor_rows
            WHERE space_id = $1 AND target_note_id = $2
            ORDER BY view_note_id, view_key LIMIT $3";
        read_rows!(
            tx,
            fetch_all,
            "projection_rank_anchor_target",
            RankKeyRow,
            SQL,
            space,
            target.as_str(),
            maximum,
        )?
    } else {
        const SQL: &str = "SELECT view_note_id, view_key, target_note_id
            FROM projection_rank_anchor_rows
            WHERE space_id = $1 AND (view_note_id, view_key, target_note_id) > ($2, $3, $4)
            ORDER BY view_note_id, view_key, target_note_id LIMIT $5";
        read_rows!(
            tx,
            fetch_all,
            "projection_rank_anchor_keys",
            RankKeyRow,
            SQL,
            space,
            after.0,
            after.1,
            after.2,
            maximum,
        )?
    };

    let mut keys = BTreeSet::new();
    for (view, key, target) in anchors {
        keys.insert(decode_rank_key(&view, &key, &target)?);
    }
    if cutoff > anchor {
        let revisions =
            revision_key_page(tx, scope, anchor, cutoff, after, by_target, maximum).await?;
        for (key,) in revisions {
            let mut parts = key.split(KEY_SEPARATOR);
            let (Some(view), Some(key), Some(target), None) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            else {
                return Err(corrupt("invalid rank revision key"));
            };
            keys.insert(decode_rank_key(view, key, target)?);
        }
    }
    Ok(keys.into_iter().take(maximum as usize).collect())
}

async fn revision_key_page(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    anchor: SpaceSeq,
    cutoff: SpaceSeq,
    after: (&str, &str, &str),
    by_target: Option<&NoteId>,
    maximum: i64,
) -> Result<Vec<(String,)>, PortError> {
    const SQLITE_PAGE: &str = revision_keys_query!(
        sqlite_rank_key,
        " INDEXED BY idx_revisions_projection_rank_key",
        concat!(sqlite_rank_key!(), " > $5"),
    );
    const PG_PAGE: &str = revision_keys_query!(
        postgres_rank_key,
        "",
        concat!(postgres_rank_key!(), " > $5"),
    );
    const SQLITE_TARGET: &str = revision_keys_query!(
        sqlite_rank_key,
        " INDEXED BY idx_revisions_projection_rank_target",
        "substr(entity_key, instr(entity_key, ':') + instr(substr(entity_key, instr(entity_key, ':') + 1), ':') + 1) = $5",
    );
    const PG_TARGET: &str = revision_keys_query!(
        postgres_rank_key,
        "",
        "split_part(entity_key, ':', 3) COLLATE \"C\" = $5",
    );

    let (key, sqlite_sql, pg_sql) = if let Some(target) = by_target {
        (target.as_str().to_owned(), SQLITE_TARGET, PG_TARGET)
    } else {
        (
            format!(
                "{}{KEY_SEPARATOR}{}{KEY_SEPARATOR}{}",
                after.0, after.1, after.2
            ),
            SQLITE_PAGE,
            PG_PAGE,
        )
    };
    let incarnation = scope.incarnation.as_bytes().as_slice();
    let start = anchor.get() as i64;
    let end = cutoff.get() as i64;
    let space = scope.space_id.as_str();
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as::<_, (String,)>(sqlite_sql)
            .bind(space)
            .bind(incarnation)
            .bind(start)
            .bind(end)
            .bind(key)
            .bind(maximum)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_projection_rank_keys", err.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_as::<_, (String,)>(pg_sql)
            .bind(space)
            .bind(incarnation)
            .bind(start)
            .bind(end)
            .bind(key)
            .bind(maximum)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_projection_rank_keys", err)),
    }
}

fn decode_rank_key(view: &str, key: &str, target: &str) -> Result<ProjectionRankKey, PortError> {
    Ok((
        NoteId::parse(view)?,
        ViewKey::parse(key)?,
        NoteId::parse(target)?,
    ))
}

async fn ranks_at_batch(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    anchor: SpaceSeq,
    cutoff: SpaceSeq,
    keys: Vec<ProjectionRankKey>,
) -> Result<Vec<ProjectionRank>, PortError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    // 1. Batch purge-fence check across every view and target note in one query.
    let mut check_notes = BTreeSet::new();
    for (view, _, target) in &keys {
        check_notes.insert(view.clone());
        check_notes.insert(target.clone());
    }
    let check_vec: Vec<NoteId> = check_notes.into_iter().collect();
    let fenced = purge_fenced_note_ids_tx(tx, &scope.space_id, &check_vec).await?;
    let live_keys: Vec<(ProjectionRankKey, String)> = keys
        .into_iter()
        .filter(|(view, _, target)| !fenced.contains(view) && !fenced.contains(target))
        .map(|key| {
            let entity = format!("{}:{}:{}", key.0, key.1, key.2);
            (key, entity)
        })
        .collect();
    if live_keys.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Batch latest post-anchor rank revision per entity_key.
    let mut latest_revs: HashMap<String, ProjectionRank> = HashMap::new();
    if cutoff > anchor {
        let space = scope.space_id.as_str();
        let incarnation = scope.incarnation.as_bytes().as_slice();
        let start = anchor.get() as i64;
        let end = cutoff.get() as i64;
        let rev_rows: Vec<(String, String, i64, Vec<u8>)> = match tx {
            BackendConn::Postgres(conn) => {
                let entity_keys: Vec<&str> = live_keys.iter().map(|(_, e)| e.as_str()).collect();
                sqlx::query_as(
                    "SELECT DISTINCT ON (entity_key) entity_key, rev_id, visibility_seq, metadata_msgpack
                     FROM revisions
                     WHERE space_id = $1 AND history_incarnation = $2 AND entity_type = 'rank'
                       AND entity_key = ANY($3) AND visibility_seq > $4 AND visibility_seq <= $5
                     ORDER BY entity_key, visibility_seq DESC, space_seq DESC",
                )
                .bind(space)
                .bind(incarnation)
                .bind(&entity_keys)
                .bind(start)
                .bind(end)
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| pg_read_error("pg_projection_ranks_batch", err))?
            }
            BackendConn::Sqlite(conn) => {
                let mut acc = Vec::new();
                for chunk in live_keys.chunks(200) {
                    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                        "SELECT entity_key, rev_id, visibility_seq, metadata_msgpack FROM (
                            SELECT entity_key, rev_id, visibility_seq, metadata_msgpack,
                                   ROW_NUMBER() OVER (PARTITION BY entity_key ORDER BY visibility_seq DESC, space_seq DESC) AS rn
                            FROM revisions
                            WHERE space_id = ",
                    );
                    qb.push_bind(space)
                        .push(" AND history_incarnation = ")
                        .push_bind(incarnation)
                        .push(" AND entity_type = 'rank' AND entity_key IN (");
                    let mut sep = qb.separated(", ");
                    for (_, entity) in chunk {
                        sep.push_bind(entity.as_str());
                    }
                    sep.push_unseparated(") AND visibility_seq > ");
                    qb.push_bind(start)
                        .push(" AND visibility_seq <= ")
                        .push_bind(end)
                        .push(") WHERE rn = 1");
                    let part: Vec<(String, String, i64, Vec<u8>)> = qb
                        .build_query_as()
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_projection_ranks_batch", err.to_string())
                        })?;
                    acc.extend(part);
                }
                acc
            }
        };
        for (entity_key, rev, visible, meta) in rev_rows {
            let row = decode_rank(rev, visible, &meta)?;
            latest_revs.insert(entity_key, row);
        }
    }

    // 3. Batch anchor fallback only for keys missing a post-anchor revision.
    let missing_keys: Vec<&ProjectionRankKey> = live_keys
        .iter()
        .filter(|(_, entity)| !latest_revs.contains_key(entity))
        .map(|(key, _)| key)
        .collect();
    let mut anchor_rows_map: HashMap<ProjectionRankKey, ProjectionRank> = HashMap::new();
    if anchor > SpaceSeq::ZERO && !missing_keys.is_empty() {
        type AnchorBatchRow = (
            String,
            String,
            String,
            String,
            Vec<u8>,
            String,
            String,
            String,
            Option<String>,
            Option<i64>,
        );
        let space = scope.space_id.as_str();
        let fetched: Vec<AnchorBatchRow> = match tx {
            BackendConn::Postgres(conn) => {
                let views: Vec<&str> = missing_keys.iter().map(|k| k.0.as_str()).collect();
                let vkeys: Vec<&str> = missing_keys.iter().map(|k| k.1.as_str()).collect();
                let targets: Vec<&str> = missing_keys.iter().map(|k| k.2.as_str()).collect();
                sqlx::query_as(
                    "SELECT a.view_note_id, a.view_key, a.target_note_id,
                            a.rank_rev_id, a.group_key_msgpack, a.sort_rank_lexo,
                            a.placement_revision, a.placement_actor_id, a.placement_run_id, r.visibility_seq
                     FROM UNNEST($2::text[], $3::text[], $4::text[]) AS k(v, vk, t)
                     JOIN projection_rank_anchor_rows a
                       ON a.space_id = $1 AND a.view_note_id = k.v AND a.view_key = k.vk AND a.target_note_id = k.t
                     LEFT JOIN revisions r ON r.space_id = a.space_id AND r.rev_id = a.rank_rev_id",
                )
                .bind(space)
                .bind(&views)
                .bind(&vkeys)
                .bind(&targets)
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| pg_read_error("pg_projection_rank_anchors_batch", err))?
            }
            BackendConn::Sqlite(conn) => {
                let mut acc = Vec::new();
                for chunk in missing_keys.chunks(100) {
                    let mut qb =
                        sqlx::QueryBuilder::<sqlx::Sqlite>::new("WITH keys(v, vk, t) AS (VALUES ");
                    let mut sep = qb.separated(", ");
                    for k in chunk {
                        sep.push("(");
                        sep.push_bind_unseparated(k.0.as_str());
                        sep.push_unseparated(", ");
                        sep.push_bind_unseparated(k.1.as_str());
                        sep.push_unseparated(", ");
                        sep.push_bind_unseparated(k.2.as_str());
                        sep.push_unseparated(")");
                    }
                    qb.push(
                        ") SELECT a.view_note_id, a.view_key, a.target_note_id,
                                 a.rank_rev_id, a.group_key_msgpack, a.sort_rank_lexo,
                                 a.placement_revision, a.placement_actor_id, a.placement_run_id, r.visibility_seq
                          FROM keys
                          JOIN projection_rank_anchor_rows a
                            ON a.space_id = ",
                    );
                    qb.push_bind(space).push(
                        " AND a.view_note_id = keys.v AND a.view_key = keys.vk AND a.target_note_id = keys.t
                          LEFT JOIN revisions r ON r.space_id = a.space_id AND r.rev_id = a.rank_rev_id",
                    );
                    let part: Vec<AnchorBatchRow> = qb
                        .build_query_as()
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed(
                                "sqlite_projection_rank_anchors_batch",
                                err.to_string(),
                            )
                        })?;
                    acc.extend(part);
                }
                acc
            }
        };
        for (view, vkey, target, rev, group, rank, placement, actor, run, visible) in fetched {
            let key = decode_rank_key(&view, &vkey, &target)?;
            let row = ProjectionRank {
                revision_id: RevisionId::parse(&rev)?,
                visibility_seq: visible.map(i64_to_space_seq).transpose()?.unwrap_or(anchor),
                metadata: RankRevisionMetadata {
                    view_note_id: key.0.clone(),
                    view_key: key.1.clone(),
                    target_note_id: key.2.clone(),
                    group_key: decode_msgpack_bounded(&group, MAX_MSGPACK_DECODE_BYTES)?,
                    sort_rank_lexo: rank,
                    placement_revision: RevisionId::parse(&placement)?,
                    placement_actor_id: PrincipalId::parse(&actor)?,
                    placement_run_id: run.as_deref().map(AgentRunId::parse).transpose()?,
                    is_pma_normalization: false,
                    removed: false,
                },
            };
            anchor_rows_map.insert(key, row);
        }
    }

    // 4. Reassemble in exact original key order.
    let mut rows = Vec::with_capacity(live_keys.len());
    for (key, entity) in live_keys {
        if let Some(row) = latest_revs.remove(&entity) {
            if row.key() != key {
                return Err(corrupt("rank revision identity does not match its key"));
            }
            if !row.metadata.removed {
                rows.push(row);
            }
        } else if let Some(row) = anchor_rows_map.remove(&key) {
            rows.push(row);
        }
    }
    Ok(rows)
}

pub(super) fn decode_rank(
    rev: String,
    visible: i64,
    bytes: &[u8],
) -> Result<ProjectionRank, PortError> {
    let RevisionMetadataPayload::Rank(metadata) = RevisionMetadataEnvelope::decode(bytes)?.payload
    else {
        return Err(corrupt("expected a rank revision"));
    };
    Ok(ProjectionRank {
        metadata,
        revision_id: RevisionId::parse(&rev)?,
        visibility_seq: i64_to_space_seq(visible)?,
    })
}
