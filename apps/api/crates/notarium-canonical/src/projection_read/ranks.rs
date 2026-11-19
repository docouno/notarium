use std::collections::BTreeSet;

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
    runtime::{are_any_notes_purge_fenced_tx, pg_read_error},
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
                let mut rows = Vec::with_capacity(keys.len());
                for key in keys {
                    if let Some(row) = rank_at(tx, &scope, anchor, cutoff, key).await? {
                        rows.push(row);
                    }
                }
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
    let mut rows = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(rank) = rank_at(tx, scope, anchor, cutoff, key).await? {
            rows.push(rank);
        }
    }
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

async fn rank_at(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    anchor: SpaceSeq,
    cutoff: SpaceSeq,
    key: ProjectionRankKey,
) -> Result<Option<ProjectionRank>, PortError> {
    if are_any_notes_purge_fenced_tx(tx, &scope.space_id, &[key.0.clone(), key.2.clone()]).await? {
        return Ok(None);
    }
    let entity = format!("{}:{}:{}", key.0, key.1, key.2);
    const REVISIONS: &str = "SELECT rev_id, visibility_seq, metadata_msgpack FROM revisions
        WHERE space_id = $1 AND history_incarnation = $2 AND entity_type = 'rank'
          AND entity_key = $3 AND visibility_seq > $4 AND visibility_seq <= $5
        ORDER BY visibility_seq DESC, space_seq DESC LIMIT 1";
    let latest = read_rows!(
        tx,
        fetch_optional,
        "projection_rank_at",
        (String, i64, Vec<u8>),
        REVISIONS,
        scope.space_id.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        entity.as_str(),
        anchor.get() as i64,
        cutoff.get() as i64,
    )?;
    if let Some((rev, visible, meta)) = latest {
        let row = decode_rank(rev, visible, &meta)?;
        if row.key() != key {
            return Err(corrupt("rank revision identity does not match its key"));
        }
        return Ok((!row.metadata.removed).then_some(row));
    }

    const ANCHOR: &str = "SELECT a.rank_rev_id, a.group_key_msgpack, a.sort_rank_lexo,
            a.placement_revision, a.placement_actor_id, a.placement_run_id, r.visibility_seq
        FROM projection_rank_anchor_rows a
        LEFT JOIN revisions r ON r.space_id = a.space_id AND r.rev_id = a.rank_rev_id
        WHERE a.space_id = $1 AND a.view_note_id = $2 AND a.view_key = $3 AND a.target_note_id = $4";
    type AnchorRow = (
        String,
        Vec<u8>,
        String,
        String,
        String,
        Option<String>,
        Option<i64>,
    );
    let source = read_rows!(
        tx,
        fetch_optional,
        "projection_rank_anchor_row",
        AnchorRow,
        ANCHOR,
        scope.space_id.as_str(),
        key.0.as_str(),
        key.1.as_str(),
        key.2.as_str(),
    )?;
    source
        .map(|(rev, group, rank, placement, actor, run, visible)| {
            Ok(ProjectionRank {
                revision_id: RevisionId::parse(&rev)?,
                visibility_seq: visible.map(i64_to_space_seq).transpose()?.unwrap_or(anchor),
                metadata: RankRevisionMetadata {
                    view_note_id: key.0,
                    view_key: key.1,
                    target_note_id: key.2,
                    group_key: decode_msgpack_bounded(&group, MAX_MSGPACK_DECODE_BYTES)?,
                    sort_rank_lexo: rank,
                    placement_revision: RevisionId::parse(&placement)?,
                    placement_actor_id: PrincipalId::parse(&actor)?,
                    placement_run_id: run.as_deref().map(AgentRunId::parse).transpose()?,
                    is_pma_normalization: false,
                    removed: false,
                },
            })
        })
        .transpose()
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
