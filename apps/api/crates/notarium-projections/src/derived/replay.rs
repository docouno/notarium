//! Durable index slot journal. Journal rows contain dense IDs only.

use notarium_core::{
    ids::{ContentDigest, SpaceId, SpaceSeq},
    model::HistoryScope,
    ports::PageLimit,
};

use super::{
    DerivedStore, ProjectedFolder, ProjectionWatermark, invalid_row, not_ready,
    read::{assert_cut, watermark},
    sql::{Kind, SqlColumn, SqlTransaction, placeholders, value},
    stale,
};
use crate::index::L0_EVENT_LIMIT;
use notarium_core::error::PortError;

const MAX_PAYLOAD_BYTES: usize = 20 + 4096 * size_of::<u32>();
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const ROW_OVERHEAD: u64 = 64;

pub(crate) struct ReplayRow {
    pub(crate) after: SpaceSeq,
    pub(crate) through: SpaceSeq,
    pub(crate) slots: Vec<u8>,
}

pub(super) async fn clear(
    tx: &mut SqlTransaction<'_>,
    space_id: &SpaceId,
) -> Result<(), PortError> {
    tx.execute(
        "DELETE FROM projection_index_replay WHERE space_id = ?",
        vec![value(space_id)],
    )
    .await?;
    Ok(())
}

pub(super) async fn prune_before(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
) -> Result<(), PortError> {
    tx.execute(
        "DELETE FROM projection_index_replay
         WHERE space_id = ? AND history_incarnation = ? AND after_seq < ?",
        vec![
            value(&scope.space_id),
            value(&scope.incarnation),
            value(&cutoff),
        ],
    )
    .await?;
    Ok(())
}

pub(super) async fn publish(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
    after: Option<SpaceSeq>,
    slots: Option<Vec<u8>>,
) -> Result<(), PortError> {
    if next.snapshot_seq == next.projected_seq {
        return Ok(());
    }
    let (Some(after), Some(slots)) = (after, slots) else {
        return clear(tx, &next.scope.space_id).await;
    };
    if slots.len() > MAX_PAYLOAD_BYTES
        || after < next.snapshot_seq
        || next.projected_seq.get() - next.snapshot_seq.get() >= u64::from(L0_EVENT_LIMIT)
    {
        return clear(tx, &next.scope.space_id).await;
    }
    let space = &next.scope.space_id;
    let history = &next.scope.incarnation;
    let mut previous = tx
        .select(
            "SELECT through_seq, accumulated_bytes FROM projection_index_replay
             WHERE space_id = ? AND history_incarnation = ? ORDER BY through_seq DESC LIMIT 1",
            vec![value(space), value(history)],
            &[Kind::Integer, Kind::Integer],
        )
        .await?;
    let bytes = match previous.pop() {
        None if after == next.snapshot_seq => 0,
        Some(row) => {
            let [through, bytes] = row.try_into().map_err(|_| invalid_row())?;
            if SpaceSeq::read(through)? != after {
                return clear(tx, space).await;
            }
            u64::read(bytes)?
        }
        None => return Ok(()),
    };
    let bytes = bytes.saturating_add(slots.len() as u64 + ROW_OVERHEAD);
    if bytes > MAX_JOURNAL_BYTES {
        return clear(tx, space).await;
    }
    let digest = ContentDigest::from_bytes(*blake3::hash(&slots).as_bytes());
    tx.execute(
        "INSERT INTO projection_index_replay (space_id, history_incarnation, after_seq,
            through_seq, accumulated_bytes, slots, digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
        vec![
            value(space),
            value(history),
            value(&after),
            value(&next.projected_seq),
            value(&bytes),
            value(&slots),
            value(&digest),
        ],
    )
    .await?;
    Ok(())
}

impl DerivedStore {
    pub(crate) async fn replay_page(
        &self,
        expected: &ProjectionWatermark,
        after: SpaceSeq,
    ) -> Result<Option<Vec<ReplayRow>>, PortError> {
        let expected = expected.clone();
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let scope = &expected.scope;
                    let Some(current) = watermark(&mut tx, &scope.space_id).await? else {
                        return Ok(None);
                    };
                    // The crash tail belongs to an exact pair of durable cuts.
                    if current.history_incarnation != scope.incarnation
                        || current.projected_seq != expected.projected_seq
                        || current.snapshot_seq != expected.snapshot_seq
                        || current.seed_in_progress
                    {
                        return Err(stale());
                    }
                    let rows = tx
                        .select(
                            "SELECT after_seq, through_seq, slots, digest
                             FROM projection_index_replay WHERE space_id = ? AND history_incarnation = ?
                              AND through_seq > ? AND through_seq <= ? ORDER BY through_seq LIMIT 200",
                            vec![
                                value(&scope.space_id),
                                value(&scope.incarnation),
                                value(&after),
                                value(&expected.projected_seq),
                            ],
                            &[Kind::Integer, Kind::Integer, Kind::Bytes, Kind::Bytes],
                        )
                        .await?;
                    let mut page = Vec::with_capacity(rows.len());
                    for row in rows {
                        let [after, through, slots, digest] =
                            row.try_into().map_err(|_| invalid_row())?;
                        let slots = Vec::<u8>::read(slots)?;
                        let digest = ContentDigest::read(digest)?;
                        if slots.len() > MAX_PAYLOAD_BYTES
                            || blake3::hash(&slots).as_bytes() != digest.as_bytes()
                        {
                            return Ok(None);
                        }
                        page.push(ReplayRow {
                            after: SpaceSeq::read(after)?,
                            through: SpaceSeq::read(through)?,
                            slots,
                        });
                    }
                    Ok(Some(page))
                })
            })
            .await
    }

    pub(crate) async fn replay_folders(
        &self,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        dense_ids: &[u32],
    ) -> Result<Vec<ProjectedFolder>, PortError> {
        if dense_ids.is_empty() {
            return Ok(Vec::new());
        }
        PageLimit::new(u16::try_from(dense_ids.len()).unwrap_or(u16::MAX))?;
        self.temporal(
            scope,
            cutoff,
            format!("dense_folder_id IN ({})", placeholders(dense_ids.len())),
            dense_ids.iter().map(value).collect(),
            "",
        )
        .await
    }

    /// One indexed batch of forward or reverse slots at the durable head.
    /// An extra row signals that the tail needs a regular rebuild.
    pub(crate) async fn replay_edges(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        dense_ids: &[u32],
        incoming: bool,
        remaining: u32,
    ) -> Result<Option<Vec<(u32, u32)>>, PortError> {
        if dense_ids.is_empty() {
            return Ok(Some(Vec::new()));
        }
        PageLimit::new(u16::try_from(dense_ids.len()).unwrap_or(u16::MAX))?;
        let scope = scope.clone();
        let key = if incoming {
            "resolved_dense_id"
        } else {
            "src_dense_id"
        };
        let sql = format!(
            "SELECT src_dense_id, resolved_dense_id FROM projected_note_links
             WHERE space_id = ? AND resolved_dense_id IS NOT NULL AND {key} IN ({}) LIMIT ?",
            placeholders(dense_ids.len()),
        );
        let mut params = vec![value(&scope.space_id)];
        params.extend(dense_ids.iter().map(value));
        params.push(value(&remaining.saturating_add(1)));
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(not_ready)?;
                    assert_cut(&row, &scope, cut)?;
                    if row.projected_seq != cut {
                        return Err(stale());
                    }
                    let rows = tx.select(&sql, params, &[Kind::Integer; 2]).await?;
                    if rows.len() > remaining as usize {
                        return Ok(None);
                    }
                    rows.into_iter()
                        .map(|row| {
                            let [source, target] = row.try_into().map_err(|_| invalid_row())?;
                            Ok((u32::read(source)?, u32::read(target)?))
                        })
                        .collect::<Result<Vec<_>, PortError>>()
                        .map(Some)
                })
            })
            .await
    }

    pub(crate) async fn replay_cut_is_current(
        &self,
        expected: &ProjectionWatermark,
    ) -> Result<bool, PortError> {
        Ok(self.watermarks(&expected.scope.space_id).await?.as_ref() == Some(expected))
    }
}
