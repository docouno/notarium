use std::collections::{BTreeMap, btree_map::Entry};

use notarium_core::{
    error::PortError,
    ids::{AgentRunId, NoteId, PrincipalId, RevisionId, SpaceId, SpaceSeq, ViewKey},
    model::{HistoryScope, Lifecycle},
    value::Timestamp,
};

use super::CandidateAction;
use crate::{
    codec::{
        MAX_MSGPACK_DECODE_BYTES, RankRevisionMetadata, RevisionMetadataEnvelope,
        RevisionMetadataPayload, decode_msgpack_bounded, internal_not_committed, lifecycle_from_db,
    },
    domain::board::rank_entity_key,
    runtime::insert_revision_row,
    sql_exec::BackendConn,
    writer::BatchEventDraft,
};

macro_rules! rank_rows {
    () => {
        "SELECT o.view_note_id, o.view_key, o.target_note_id, o.group_key_msgpack,
                o.sort_rank_lexo, o.rank_rev_id, o.placement_revision,
                o.placement_actor_id, o.placement_run_id, h.lifecycle_state
         FROM view_rank_overlays o CROSS JOIN note_heads h
         WHERE o.space_id = $1 AND h.space_id = o.space_id AND h.note_id = o.target_note_id AND "
    };
}
// Use separate key ranges in SQLite. The CROSS JOIN keeps the indexed overlay
// lookup outside the target head probe.
const RANKS_BY_ENDPOINT: &str = concat!(
    rank_rows!(),
    "o.target_note_id = $2 UNION ALL ",
    rank_rows!(),
    "o.view_note_id = $2 AND o.target_note_id <> $2"
);
const DELETE_RANK: &str = "DELETE FROM view_rank_overlays
    WHERE space_id = $1 AND view_note_id = $2 AND view_key = $3
          AND target_note_id = $4 AND rank_rev_id = $5";

type RawRank = (
    String,
    String,
    String,
    Vec<u8>,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
);
type RemovalsByKey = BTreeMap<(NoteId, ViewKey, NoteId), RankRemoval>;

pub(crate) struct RankRemoval {
    metadata: RankRevisionMetadata,
    pub(crate) previous: RevisionId,
    lifecycle: Lifecycle,
}

fn add_removal(
    out: &mut RemovalsByKey,
    eligible: &BTreeMap<NoteId, CandidateAction>,
    raw: RawRank,
) -> Result<(), PortError> {
    let (view, key, target, group, rank, previous, placement, actor, run, lifecycle) = raw;
    let view = NoteId::parse(&view)?;
    let key = ViewKey::parse(&key)?;
    let target = NoteId::parse(&target)?;
    let tuple = (view.clone(), key.clone(), target.clone());
    let Entry::Vacant(entry) = out.entry(tuple) else {
        return Ok(());
    };
    let lifecycle = match eligible.get(&target) {
        Some(CandidateAction::TrashCreated { .. }) => Lifecycle::Trashed,
        Some(CandidateAction::RestorePreExisting {
            pre_meta,
            needs_note_mutation: true,
            ..
        }) => pre_meta.lifecycle,
        _ => lifecycle_from_db(&lifecycle)?,
    };
    entry.insert(RankRemoval {
        metadata: RankRevisionMetadata {
            view_note_id: view,
            view_key: key,
            target_note_id: target,
            group_key: decode_msgpack_bounded(&group, MAX_MSGPACK_DECODE_BYTES)?,
            sort_rank_lexo: rank,
            placement_revision: RevisionId::parse(&placement)?,
            placement_actor_id: PrincipalId::parse(&actor)?,
            placement_run_id: run.as_deref().map(AgentRunId::parse).transpose()?,
            is_pma_normalization: false,
            removed: true,
        },
        previous: RevisionId::parse(&previous)?,
        lifecycle,
    });
    Ok(())
}

pub(super) fn removes_ranks(action: Option<&CandidateAction>) -> bool {
    match action {
        Some(CandidateAction::TrashCreated { .. }) => true,
        Some(CandidateAction::RestorePreExisting {
            pre_meta,
            needs_note_mutation: true,
            ..
        }) => pre_meta.lifecycle != Lifecycle::Active,
        _ => false,
    }
}

fn select_endpoints(eligible: &BTreeMap<NoteId, CandidateAction>) -> impl Iterator<Item = &NoteId> {
    eligible
        .iter()
        .filter_map(|(note, action)| removes_ranks(Some(action)).then_some(note))
}

pub(super) async fn plan_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    eligible: &BTreeMap<NoteId, CandidateAction>,
) -> Result<Vec<RankRemoval>, PortError> {
    let err = |e: sqlx::Error| internal_not_committed("rollback_rank_read", e.to_string());
    let mut removals = BTreeMap::new();
    macro_rules! load {
        ($conn:expr) => {
            for note in select_endpoints(eligible) {
                let rows: Vec<RawRank> = sqlx::query_as(RANKS_BY_ENDPOINT)
                    .bind(space.as_str())
                    .bind(note.as_str())
                    .fetch_all(&mut **$conn)
                    .await
                    .map_err(err)?;
                for row in rows {
                    add_removal(&mut removals, eligible, row)?;
                }
            }
        };
    }
    match tx {
        BackendConn::Sqlite(conn) => {
            load!(conn);
        }
        BackendConn::Postgres(conn) => {
            load!(conn);
        }
    }
    Ok(removals.into_values().collect())
}

impl RankRemoval {
    pub(crate) fn entity_key(&self) -> String {
        let rank = &self.metadata;
        rank_entity_key(&rank.view_note_id, &rank.view_key, &rank.target_note_id)
    }

    pub(crate) fn revision_metadata(&self) -> Result<Vec<u8>, PortError> {
        RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Rank(self.metadata.clone())).encode()
    }

    pub(crate) fn event(&self, seq: SpaceSeq, revision: RevisionId) -> BatchEventDraft {
        BatchEventDraft {
            space_seq: seq,
            entity_type: "note".to_owned(),
            entity_id: self.metadata.target_note_id.as_str().to_owned(),
            op_kind: "move".to_owned(),
            rev_id: revision,
            lifecycle: self.lifecycle,
            doc_class: None,
        }
    }

    fn check_deleted(affected: u64) -> Result<(), PortError> {
        if affected == 1 {
            return Ok(());
        }
        Err(internal_not_committed(
            "rollback_rank_delete",
            "planned rank row is missing or changed within the rollback",
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn write_tx(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
        seq: SpaceSeq,
        cut: SpaceSeq,
        revision: &RevisionId,
        actor: &PrincipalId,
        now: Timestamp,
    ) -> Result<(), PortError> {
        let rank = &self.metadata;
        macro_rules! delete {
            ($conn:expr) => {
                sqlx::query(DELETE_RANK)
                    .bind(scope.space_id.as_str())
                    .bind(rank.view_note_id.as_str())
                    .bind(rank.view_key.as_str())
                    .bind(rank.target_note_id.as_str())
                    .bind(self.previous.as_str())
                    .execute(&mut **$conn)
                    .await
                    .map(|r| r.rows_affected())
            };
        }
        let affected = match tx {
            BackendConn::Sqlite(conn) => delete!(conn),
            BackendConn::Postgres(conn) => delete!(conn),
        }
        .map_err(|e| internal_not_committed("rollback_rank_delete", e.to_string()))?;
        Self::check_deleted(affected)?;
        insert_revision_row(
            tx,
            scope,
            revision,
            "rank",
            &self.entity_key(),
            seq,
            cut,
            Some(&self.previous),
            None,
            None,
            &self.revision_metadata()?,
            actor,
            None,
            now,
        )
        .await
    }

    pub(crate) fn owners(&self) -> [&NoteId; 2] {
        [&self.metadata.view_note_id, &self.metadata.target_note_id]
    }
}

#[cfg(test)]
#[test]
fn legacy_rank_metadata_defaults_to_present() {
    use notarium_core::ports::GroupKey;

    let rank = RankRevisionMetadata {
        view_note_id: NoteId::from_bytes([1; 16]),
        view_key: ViewKey::from_bytes([2; 16]),
        target_note_id: NoteId::from_bytes([3; 16]),
        group_key: GroupKey::Absent,
        sort_rank_lexo: "000000000007".to_owned(),
        placement_revision: RevisionId::from_bytes([4; 16]),
        placement_actor_id: PrincipalId::from_bytes([5; 16]),
        placement_run_id: None,
        is_pma_normalization: false,
        removed: false,
    };
    let mut previous_wire = serde_json::to_value(&rank).unwrap();
    previous_wire.as_object_mut().unwrap().remove("removed");
    let previous_bytes = crate::codec::encode_msgpack(&previous_wire).unwrap();
    let restored: RankRevisionMetadata =
        decode_msgpack_bounded(&previous_bytes, MAX_MSGPACK_DECODE_BYTES).unwrap();
    assert_eq!(restored, rank);
}
