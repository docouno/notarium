use std::collections::{BTreeMap, HashMap};

use notarium_core::{
    DomainError,
    classes::{DocClass, authorize_field_key},
    error::{Diagnostic, PortError, ValidationReason},
    ids::{AgentRunId, ContentDigest, NoteId, PrincipalId, RevisionId, SpaceId, SpaceSeq, ViewKey},
    model::{HistoryScope, Lifecycle},
    ports::{
        BoardMoveFacts, BoardMoveResult, Committed, EvaluatedBoardRow, GroupKey,
        InterceptedMutation, InterceptedPayload, InterceptionResult, MoveBoardCard, Mutation,
        NoteRevision, RankExpectation, SemanticPlacement, SpaceContext, ViewRef,
    },
    receipt::MutationReceiptToken,
    value::Timestamp,
};
use notarium_syntax::frontmatter::FieldEdit;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{
    CanonicalStore,
    blobs::{BlobOwnerKind, BlobReferenceClaim, activate_and_bind_blob_ref_tx},
    changes::{
        ChangedNoteSummaryV1, EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft,
    },
    codec::{
        EFFECT_MAX_NOTES, MAX_MSGPACK_DECODE_BYTES, NoteRevisionMetadata, RankRevisionMetadata,
        RevisionMetadataEnvelope, RevisionMetadataPayload, decode_msgpack_bounded, encode_msgpack,
        encode_timestamp_parts, evaluate_fields_with_schema, group_key_hex, internal_not_committed,
        new_prefixed_hex_id, new_revision_id, now_utc_timestamp, unavailable_retryable,
    },
    domain::{
        common::{
            StoredCommittedBoardMoveV1, build_resource_facts_tx, check_collab_preconditions_tx,
            derive_command_identity_spec, extract_agent_run_from_auth, is_note_room_active_tx,
            load_current_space_schema_tx, load_note_head_row_tx, note_rank_version_digest,
            upsert_agent_run_head_tx, validate_mutation_identity,
        },
        notes::{
            analyze_and_prepare_carrier, applied_outcome, changed_revision_fields_tx,
            try_replay_completed_receipt,
        },
    },
    runtime::{insert_revision_row, is_note_purge_fenced_tx, load_space_record},
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent, SemanticCutMismatchKind},
};

/// Fixed 12-character lowercase Base36 (`0-9a-z`) rank encoding (`12 <= 16` bytes).
///
/// Using `0-9a-z` guarantees identical lexicographical sort order across Rust UTF-8 bytes,
/// SQLite `BINARY` collation, and PostgreSQL `C` / `en_US.utf8` collations, while giving
/// `36^12 = 4,738,381,338,321,616,896` (`~62.04` bits) of integer keyspace.
pub const RANK_WIDTH: usize = 12;
pub const RANK_RADIX: u128 = 36;
pub const RANK_SPACE: u128 = 4_738_381_338_321_616_896; // 36^12
const BASE36_ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const MAX_PLANNER_RETRIES: usize = 4;

pub(super) fn rank_entity_key(view: &NoteId, key: &ViewKey, target: &NoteId) -> String {
    format!("{view}:{key}:{target}")
}

pub fn encode_rank_u128(mut value: u128) -> Result<String, PortError> {
    if value == 0 || value >= RANK_SPACE {
        return Err(internal_not_committed(
            "rank_out_of_bounds",
            format!("rank value {value} outside (0, {RANK_SPACE})"),
        ));
    }
    let mut buf = [b'0'; RANK_WIDTH];
    for idx in (0..RANK_WIDTH).rev() {
        let digit = (value % RANK_RADIX) as usize;
        buf[idx] = BASE36_ALPHABET[digit];
        value /= RANK_RADIX;
    }
    String::from_utf8(buf.to_vec())
        .map_err(|err| internal_not_committed("rank_utf8", err.to_string()))
}

pub fn decode_rank_u128(rank: &str) -> Result<u128, PortError> {
    if rank.is_empty() || rank.len() > 16 {
        return Err(internal_not_committed(
            "corrupt_rank_len",
            format!("invalid rank length {}", rank.len()),
        ));
    }
    let mut acc: u128 = 0;
    for idx in 0..RANK_WIDTH {
        let ch = rank.as_bytes().get(idx).copied().unwrap_or(b'0');
        let digit: u128 = match ch {
            b'0'..=b'9' => u128::from(ch - b'0'),
            b'a'..=b'z' => u128::from(ch - b'a' + 10),
            b'A'..=b'Z' => u128::from(ch - b'A' + 10),
            _ => {
                return Err(internal_not_committed(
                    "corrupt_rank_char",
                    format!("invalid rank byte {ch}"),
                ));
            }
        };
        acc = acc * RANK_RADIX + digit;
    }
    if acc == 0 || acc >= RANK_SPACE {
        return Err(internal_not_committed(
            "corrupt_rank_zero",
            format!("decoded rank {acc} outside valid bounds"),
        ));
    }
    Ok(acc)
}

/// Computes `count` evenly spaced initial ranks across `(0, RANK_SPACE)`.
pub fn evenly_spaced_ranks(count: usize) -> Result<Vec<String>, PortError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let denom = (count as u128) + 1;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let num = ((i as u128) + 1) * (RANK_SPACE / denom);
        out.push(encode_rank_u128(num.clamp(1, RANK_SPACE - 1))?);
    }
    Ok(out)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExistingRankedItem {
    pub note_id: NoteId,
    pub rank: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputedRankPlacement {
    pub target_rank: String,
    /// `(neighbor_note_id, new_rank)` for neighbors normalized by Window PMA.
    pub pma_neighbor_updates: Vec<(NoteId, String)>,
}

/// Computes `target_rank` when placing `target_note` at `insert_index` (`0..=existing_without_target.len()`)
/// among `existing_without_target` (sorted strictly ascending by `(rank, note_id)`).
///
/// Uses exact integer midpoint in `(0, 36^12)` when `hi - lo >= 2`, falling back to bounded
/// local Window PMA (`W = 8, 16, 32, ..., L`) when local gap precision is exhausted.
pub fn compute_rank_placement(
    existing_without_target: &[ExistingRankedItem],
    _target_note: &NoteId,
    insert_index: usize,
) -> Result<ComputedRankPlacement, PortError> {
    if insert_index > existing_without_target.len() {
        return Err(internal_not_committed(
            "invalid_rank_insert_index",
            format!(
                "insert_index {insert_index} > len {}",
                existing_without_target.len()
            ),
        ));
    }

    let lo = if insert_index == 0 {
        0
    } else {
        decode_rank_u128(&existing_without_target[insert_index - 1].rank)?
    };
    let hi = if insert_index == existing_without_target.len() {
        RANK_SPACE
    } else {
        decode_rank_u128(&existing_without_target[insert_index].rank)?
    };

    if hi > lo && (hi - lo) >= 2 {
        let mid = lo + (hi - lo) / 2;
        return Ok(ComputedRankPlacement {
            target_rank: encode_rank_u128(mid)?,
            pma_neighbor_updates: Vec::new(),
        });
    }

    // Map desired sequence index `0..total_len` (where `target_note` is virtually inserted at
    // `insert_index`) directly onto `existing_without_target` without O(N) cloning.
    let total_len = existing_without_target.len() + 1;
    let existing_at_desired = |desired_idx: usize| -> &ExistingRankedItem {
        debug_assert_ne!(desired_idx, insert_index);
        if desired_idx < insert_index {
            &existing_without_target[desired_idx]
        } else {
            &existing_without_target[desired_idx - 1]
        }
    };

    let mut win_size = 8usize.min(total_len);
    let mut level: u32 = 0;
    loop {
        let half = win_size / 2;
        let w_start = insert_index.saturating_sub(half).min(total_len - win_size);
        let w_end = w_start + win_size;

        let bound_lo = if w_start == 0 {
            0
        } else {
            decode_rank_u128(&existing_at_desired(w_start - 1).rank)?
        };
        let bound_hi = if w_end == total_len {
            RANK_SPACE
        } else {
            decode_rank_u128(&existing_at_desired(w_end).rank)?
        };

        let slots = (win_size as u128) + 1;
        let span = bound_hi.saturating_sub(bound_lo);
        let full_group = w_start == 0 && w_end == total_len;
        // Geometric per-level PMA gap threshold (`16, 256, 4096, 65536, ...` up to 2^40):
        // when level `k` redistributes `2W` items, child windows of level `k - 1` accept a 16x smaller
        // gap, absorbing local halvings so amortized neighbor updates across 10k slot-0 moves stay < 2/move.
        let shift = (4 * (level + 1)).min(40);
        let required_gap = if full_group { 1 } else { 1u128 << shift };

        if span >= slots.saturating_mul(required_gap) && span >= slots {
            let mut target_rank_out = None;
            let mut neighbor_updates = Vec::new();
            for offset in 0..win_size {
                // Integer interpolation `(span * (offset + 1)) / slots` cannot overflow u128
                // since `span <= 36^12 (~4.73e18)` and `offset + 1 <= total_len + 1`.
                let assigned = bound_lo + (span * ((offset as u128) + 1)) / slots;
                let encoded = encode_rank_u128(assigned)?;
                let desired_idx = w_start + offset;
                if desired_idx == insert_index {
                    target_rank_out = Some(encoded);
                } else {
                    let existing_item = existing_at_desired(desired_idx);
                    let old_val = decode_rank_u128(&existing_item.rank)?;
                    if assigned != old_val {
                        neighbor_updates.push((existing_item.note_id.clone(), encoded));
                    }
                }
            }
            let target_rank = target_rank_out.ok_or_else(|| {
                internal_not_committed("pma_missing_target", "window excluded target index")
            })?;
            return Ok(ComputedRankPlacement {
                target_rank,
                pma_neighbor_updates: neighbor_updates,
            });
        }

        if win_size == total_len {
            return Err(internal_not_committed(
                "pma_keyspace_exhausted",
                "rank keyspace exhausted across full group",
            ));
        }
        win_size = win_size.saturating_mul(2).min(total_len);
        level = level.saturating_add(1);
    }
}

/// Adjacently-tagged MessagePack mirror of `notarium_core::ports::SemanticPlacement`
/// (`notarium_core`'s `SemanticPlacement` is internally tagged for JSON/utoipa).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "placement", content = "data", rename_all = "snake_case")]
pub(crate) enum StoredSemanticPlacementV1 {
    Ineligible,
    InGroup {
        group: GroupKey,
        predecessor: Option<NoteId>,
        successor: Option<NoteId>,
    },
}

impl From<&SemanticPlacement> for StoredSemanticPlacementV1 {
    fn from(value: &SemanticPlacement) -> Self {
        match value {
            SemanticPlacement::OutsideView => Self::Ineligible,
            SemanticPlacement::InGroup {
                group,
                predecessor,
                successor,
            } => Self::InGroup {
                group: group.clone(),
                predecessor: predecessor.clone(),
                successor: successor.clone(),
            },
        }
    }
}

impl From<StoredSemanticPlacementV1> for SemanticPlacement {
    fn from(value: StoredSemanticPlacementV1) -> Self {
        match value {
            StoredSemanticPlacementV1::Ineligible => Self::OutsideView,
            StoredSemanticPlacementV1::InGroup {
                group,
                predecessor,
                successor,
            } => Self::InGroup {
                group,
                predecessor,
                successor,
            },
        }
    }
}

#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct OverlayRow {
    pub target_note_id: NoteId,
    pub group: GroupKey,
    pub group_key_hex: String,
    pub sort_rank_lexo: String,
    pub rank_rev_id: RevisionId,
    pub placement_revision: RevisionId,
    pub placement_actor_id: PrincipalId,
    pub placement_run_id: Option<AgentRunId>,
    pub updated_seq: SpaceSeq,
}

impl CanonicalStore {
    #[cfg(feature = "test-support")]
    pub async fn inspect_view_overlays_for_test(
        &self,
        space_id: &SpaceId,
        view: &ViewRef,
    ) -> Result<HashMap<NoteId, OverlayRow>, PortError> {
        let sid = space_id.clone();
        let vw = view.clone();
        self.with_read_tx(|tx| Box::pin(async move { load_view_overlays_tx(tx, &sid, &vw).await }))
            .await
    }

    #[cfg(feature = "test-support")]
    pub async fn inspect_agent_run_revision_for_test(
        &self,
        space_id: &SpaceId,
        run: &AgentRunId,
    ) -> Result<Option<RevisionId>, PortError> {
        self.inspect_agent_run_revision_with_budget_for_test(space_id, run, None)
            .await
    }

    #[cfg(feature = "test-support")]
    pub async fn inspect_agent_run_revision_with_budget_for_test(
        &self,
        space_id: &SpaceId,
        run: &AgentRunId,
        budget: Option<&notarium_core::ports::CallBudget>,
    ) -> Result<Option<RevisionId>, PortError> {
        let sid = space_id.clone();
        let rid = run.clone();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let raw: Option<String> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT run_revision FROM agent_run_heads WHERE space_id = ? AND run_id = ?",
                    )
                    .bind(sid.as_str())
                    .bind(rid.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_load_run_rev", err.to_string()))?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT run_revision FROM agent_run_heads WHERE space_id = $1 AND run_id = $2",
                    )
                    .bind(sid.as_str())
                    .bind(rid.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_load_run_rev", err.to_string()))?,
                };
                match raw {
                    Some(s) => Ok(Some(RevisionId::parse(&s)?)),
                    None => Ok(None),
                }
            })
        })
        .await
    }
}

type RawOverlayTuple = (
    Vec<u8>,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
);

type RawViewOverlayTuple = (
    String,
    Vec<u8>,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
);

pub(crate) async fn load_overlay_row_opt_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    view: &ViewRef,
    target_note: &NoteId,
) -> Result<Option<OverlayRow>, PortError> {
    let raw: Option<RawOverlayTuple> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                    "SELECT group_key_msgpack, group_key_hex, sort_rank_lexo, rank_rev_id,
                            placement_revision, placement_actor_id, placement_run_id, updated_seq
                     FROM view_rank_overlays
                     WHERE space_id = ? AND view_note_id = ? AND view_key = ? AND target_note_id = ?",
                )
                .bind(space_id.as_str())
                .bind(view.note.as_str())
                .bind(view.key.as_str())
                .bind(target_note.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_load_overlay_row", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("group_key_msgpack"),
                    r.get("group_key_hex"),
                    r.get("sort_rank_lexo"),
                    r.get("rank_rev_id"),
                    r.get("placement_revision"),
                    r.get("placement_actor_id"),
                    r.get("placement_run_id"),
                    r.get("updated_seq"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                    "SELECT group_key_msgpack, group_key_hex, sort_rank_lexo, rank_rev_id,
                            placement_revision, placement_actor_id, placement_run_id, updated_seq
                     FROM view_rank_overlays
                     WHERE space_id = $1 AND view_note_id = $2 AND view_key = $3 AND target_note_id = $4",
                )
                .bind(space_id.as_str())
                .bind(view.note.as_str())
                .bind(view.key.as_str())
                .bind(target_note.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| crate::runtime::pg_read_error("pg_load_overlay_row", err))?;
            row.map(|r| {
                (
                    r.get("group_key_msgpack"),
                    r.get("group_key_hex"),
                    r.get("sort_rank_lexo"),
                    r.get("rank_rev_id"),
                    r.get("placement_revision"),
                    r.get("placement_actor_id"),
                    r.get("placement_run_id"),
                    r.get("updated_seq"),
                )
            })
        }
    };

    let Some((gk_bytes, gk_hex, rank_lexo, rrev, prev, pactor, prun, useq)) = raw else {
        return Ok(None);
    };
    decode_overlay_tuple(
        target_note.clone(),
        gk_bytes,
        gk_hex,
        rank_lexo,
        rrev,
        prev,
        pactor,
        prun,
        useq,
    )
    .map(Some)
}

pub(crate) async fn load_view_overlays_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    view: &ViewRef,
) -> Result<HashMap<NoteId, OverlayRow>, PortError> {
    let rows: Vec<RawViewOverlayTuple> = match tx {
        BackendConn::Sqlite(conn) => {
            let fetched = sqlx::query(
                "SELECT target_note_id, group_key_msgpack, group_key_hex, sort_rank_lexo, rank_rev_id,
                        placement_revision, placement_actor_id, placement_run_id, updated_seq
                 FROM view_rank_overlays
                 WHERE space_id = ? AND view_note_id = ? AND view_key = ?",
            )
            .bind(space_id.as_str())
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_view_overlays", err.to_string()))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("target_note_id"),
                        r.get("group_key_msgpack"),
                        r.get("group_key_hex"),
                        r.get("sort_rank_lexo"),
                        r.get("rank_rev_id"),
                        r.get("placement_revision"),
                        r.get("placement_actor_id"),
                        r.get("placement_run_id"),
                        r.get("updated_seq"),
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let fetched = sqlx::query(
                "SELECT target_note_id, group_key_msgpack, group_key_hex, sort_rank_lexo, rank_rev_id,
                        placement_revision, placement_actor_id, placement_run_id, updated_seq
                 FROM view_rank_overlays
                 WHERE space_id = $1 AND view_note_id = $2 AND view_key = $3",
            )
            .bind(space_id.as_str())
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_view_overlays", err))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("target_note_id"),
                        r.get("group_key_msgpack"),
                        r.get("group_key_hex"),
                        r.get("sort_rank_lexo"),
                        r.get("rank_rev_id"),
                        r.get("placement_revision"),
                        r.get("placement_actor_id"),
                        r.get("placement_run_id"),
                        r.get("updated_seq"),
                    )
                })
                .collect()
        }
    };

    let mut map = HashMap::with_capacity(rows.len());
    for (tn_raw, gk_bytes, gk_hex, rank_lexo, rrev, prev, pactor, prun, useq) in rows {
        let target_note_id = NoteId::parse(&tn_raw)
            .map_err(|_| internal_not_committed("corrupt_overlay_target", "invalid NoteId"))?;
        let decoded = decode_overlay_tuple(
            target_note_id.clone(),
            gk_bytes,
            gk_hex,
            rank_lexo,
            rrev,
            prev,
            pactor,
            prun,
            useq,
        )?;
        map.insert(target_note_id, decoded);
    }
    Ok(map)
}

#[allow(clippy::too_many_arguments)]
fn decode_overlay_tuple(
    target_note_id: NoteId,
    gk_bytes: Vec<u8>,
    group_key_hex: String,
    sort_rank_lexo: String,
    rrev: String,
    prev: String,
    pactor: String,
    prun: Option<String>,
    useq: i64,
) -> Result<OverlayRow, PortError> {
    let group: GroupKey = decode_msgpack_bounded(&gk_bytes, MAX_MSGPACK_DECODE_BYTES)?;
    let rank_rev_id = RevisionId::parse(&rrev)
        .map_err(|_| internal_not_committed("corrupt_rank_rev", "invalid rank_rev_id"))?;
    let placement_revision = RevisionId::parse(&prev).map_err(|_| {
        internal_not_committed("corrupt_placement_rev", "invalid placement_revision")
    })?;
    let placement_actor_id = PrincipalId::parse(&pactor)
        .map_err(|_| internal_not_committed("corrupt_placement_actor", "invalid actor_id"))?;
    let placement_run_id = match prun {
        Some(s) => Some(
            AgentRunId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_placement_run", "invalid run_id"))?,
        ),
        None => None,
    };
    let updated_seq = crate::codec::i64_to_space_seq(useq)?;
    Ok(OverlayRow {
        target_note_id,
        group,
        group_key_hex,
        sort_rank_lexo,
        rank_rev_id,
        placement_revision,
        placement_actor_id,
        placement_run_id,
        updated_seq,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn upsert_overlay_and_rank_revision_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    view: &ViewRef,
    target_note: &NoteId,
    group: &GroupKey,
    sort_rank_lexo: &str,
    rank_rev_id: &RevisionId,
    parent_rank_rev: Option<&RevisionId>,
    placement_revision: &RevisionId,
    placement_actor_id: &PrincipalId,
    placement_run_id: Option<&AgentRunId>,
    mutation_actor_id: &PrincipalId,
    mutation_run_id: Option<&AgentRunId>,
    is_pma_normalization: bool,
    space_seq: SpaceSeq,
    visibility_seq: SpaceSeq,
    now_ts: Timestamp,
) -> Result<(), PortError> {
    let (gk_msgpack, gk_hex) = group_key_hex(group)?;
    let vis_i64 = visibility_seq.get() as i64;
    let run_str = placement_run_id.map(AgentRunId::as_str);

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO view_rank_overlays (
                    space_id, view_note_id, view_key, target_note_id,
                    group_key_msgpack, group_key_hex, sort_rank_lexo,
                    rank_rev_id, placement_revision, placement_actor_id, placement_run_id, updated_seq
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (space_id, view_note_id, view_key, target_note_id) DO UPDATE SET
                    group_key_msgpack = excluded.group_key_msgpack,
                    group_key_hex = excluded.group_key_hex,
                    sort_rank_lexo = excluded.sort_rank_lexo,
                    rank_rev_id = excluded.rank_rev_id,
                    placement_revision = excluded.placement_revision,
                    placement_actor_id = excluded.placement_actor_id,
                    placement_run_id = excluded.placement_run_id,
                    updated_seq = excluded.updated_seq",
            )
            .bind(scope.space_id.as_str())
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .bind(target_note.as_str())
            .bind(&gk_msgpack)
            .bind(&gk_hex)
            .bind(sort_rank_lexo)
            .bind(rank_rev_id.as_str())
            .bind(placement_revision.as_str())
            .bind(placement_actor_id.as_str())
            .bind(run_str)
            .bind(vis_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_upsert_overlay", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO view_rank_overlays (
                    space_id, view_note_id, view_key, target_note_id,
                    group_key_msgpack, group_key_hex, sort_rank_lexo,
                    rank_rev_id, placement_revision, placement_actor_id, placement_run_id, updated_seq
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (space_id, view_note_id, view_key, target_note_id) DO UPDATE SET
                    group_key_msgpack = EXCLUDED.group_key_msgpack,
                    group_key_hex = EXCLUDED.group_key_hex,
                    sort_rank_lexo = EXCLUDED.sort_rank_lexo,
                    rank_rev_id = EXCLUDED.rank_rev_id,
                    placement_revision = EXCLUDED.placement_revision,
                    placement_actor_id = EXCLUDED.placement_actor_id,
                    placement_run_id = EXCLUDED.placement_run_id,
                    updated_seq = EXCLUDED.updated_seq",
            )
            .bind(scope.space_id.as_str())
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .bind(target_note.as_str())
            .bind(&gk_msgpack)
            .bind(&gk_hex)
            .bind(sort_rank_lexo)
            .bind(rank_rev_id.as_str())
            .bind(placement_revision.as_str())
            .bind(placement_actor_id.as_str())
            .bind(run_str)
            .bind(vis_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_upsert_overlay", err.to_string()))?;
        }
    }

    let rank_entity_key = rank_entity_key(&view.note, &view.key, target_note);
    let rank_meta =
        RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Rank(RankRevisionMetadata {
            view_note_id: view.note.clone(),
            view_key: view.key.clone(),
            target_note_id: target_note.clone(),
            group_key: group.clone(),
            sort_rank_lexo: sort_rank_lexo.to_owned(),
            placement_revision: placement_revision.clone(),
            placement_actor_id: placement_actor_id.clone(),
            placement_run_id: placement_run_id.cloned(),
            is_pma_normalization,
            removed: false,
        }))
        .encode()?;

    // NOTE: For pure PMA neighbor normalizations, we pass `None` as `agent_run_id` on the rank
    // revision row (while preserving `placement_run_id` inside `view_rank_overlays` and metadata)
    // so run-history queries never misattribute a neighbor's placement to a normalizing run.
    let recorded_run = if is_pma_normalization {
        None
    } else {
        mutation_run_id
    };

    insert_revision_row(
        tx,
        scope,
        rank_rev_id,
        "rank",
        &rank_entity_key,
        space_seq,
        visibility_seq,
        parent_rank_rev,
        None,
        None,
        &rank_meta,
        mutation_actor_id,
        recorded_run,
        now_ts,
    )
    .await
}

pub(crate) fn verify_rank_expectation(
    expected: &RankExpectation,
    actual: Option<&OverlayRow>,
    fallback_conflict_rev: &RevisionId,
) -> Result<(), PortError> {
    match (expected, actual) {
        (RankExpectation::Absent, None) => Ok(()),
        (RankExpectation::Absent, Some(row)) => Err(DomainError::RevisionConflict {
            current: row.rank_rev_id.clone(),
            lineage: None,
        }
        .into()),
        (RankExpectation::Existing(exp), Some(row)) if *exp == row.rank_rev_id => Ok(()),
        (RankExpectation::Existing(_), Some(row)) => Err(DomainError::RevisionConflict {
            current: row.rank_rev_id.clone(),
            lineage: None,
        }
        .into()),
        (RankExpectation::Existing(_), None) => Err(DomainError::RevisionConflict {
            current: fallback_conflict_rev.clone(),
            lineage: None,
        }
        .into()),
    }
}

fn destination_group_rows<'a>(
    facts: &'a BoardMoveFacts,
    input: &MoveBoardCard,
) -> Result<&'a [EvaluatedBoardRow], DomainError> {
    let rows = facts
        .groups()
        .iter()
        .find(|g| g.group == input.group)
        .map(|g| g.rows.as_slice())
        .unwrap_or_default();
    for neighbor in input.before.iter().chain(&input.after) {
        if !rows.iter().any(|row| row.note == neighbor.note) {
            return Err(DomainError::validation(ValidationReason::InvalidState));
        }
    }
    Ok(rows)
}

pub(crate) async fn move_board_card_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<MoveBoardCard>,
) -> Result<Committed<BoardMoveResult>, PortError> {
    let deadline = super::common::CommandDeadline::start(&ctx.budget, "board_move");
    validate_mutation_identity(&ctx, &request.identity)?;
    for (field_key, opt_val) in &request.input.fields {
        authorize_field_key(field_key)?;
        if let Some(val) = opt_val {
            val.validate_keys()?;
        }
    }
    if let Some(ref b) = request.input.before
        && b.note == request.input.note
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if let Some(ref a) = request.input.after
        && a.note == request.input.note
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if let (Some(b), Some(a)) = (&request.input.before, &request.input.after)
        && b.note == a.note
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    let mut idemp = build_move_board_card_identity_spec(&request)?.with_policy(
        ctx.auth(),
        crate::writer::replay::ReplayPolicy::Documents(vec![
            crate::writer::replay::ReplayResource::Write(request.input.note.clone()),
            crate::writer::replay::ReplayResource::View(request.input.view.note.clone()),
        ]),
    );
    idemp.require_receipt_detail = true;
    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    if let Some(replayed) = deadline
        .wait(&ctx.budget, || {
            try_replay_completed_receipt::<StoredCommittedBoardMoveV1>(
                store,
                ctx.scope(),
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await??
    {
        return Ok(replayed.into_committed());
    }

    let (board_authority, provider) = store.board_facts_provider()?;

    for attempt in 0..MAX_PLANNER_RETRIES {
        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        // Pre-read target note head & authorize direct write before live-room interception or CAS staging.
        let ctx_read = ctx.clone();
        let target_id = request.input.note.clone();
        let view_id = request.input.view.note.clone();
        let prec_read = request.preconditions.clone();
        let (space_rec, base_head) = store
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    let srec = load_space_record(tx, &ctx_read.scope().space_id).await?;
                    srec.scope.check(ctx_read.scope())?;
                    if is_note_purge_fenced_tx(tx, &srec.scope.space_id, target_id.as_str()).await?
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let head = load_note_head_row_tx(tx, &srec.scope.space_id, &target_id).await?;
                    if head.lifecycle != Lifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let (rfacts, _) = build_resource_facts_tx(
                        tx,
                        &srec.space,
                        &head.parent_folder_id,
                        head.doc_class,
                        head.ability_id.clone(),
                        true,
                    )
                    .await?;
                    ctx_read.auth().authorize_direct_write(&rfacts, &rfacts)?;
                    authorized_view_head(tx, &srec.space, ctx_read.auth(), &view_id).await?;
                    if prec_read
                        .revision
                        .as_ref()
                        .is_some_and(|r| *r != head.head_rev_id)
                    {
                        return Err(DomainError::RevisionConflict {
                            current: head.head_rev_id,
                            lineage: None,
                        }
                        .into());
                    }
                    check_collab_preconditions_tx(tx, &srec.scope.space_id, &target_id, &prec_read)
                        .await?;
                    Ok((srec, head))
                })
            })
            .await?;

        if base_head.doc_class == DocClass::EncryptedNote {
            return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
        }

        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        let facts = deadline
            .wait(&ctx.budget, || {
                provider.evaluate_move(&board_authority, ctx.clone(), None, request.input.clone())
            })
            .await??;
        facts.verify_authority(&board_authority)?;
        ctx.scope().check(facts.scope())?;
        if facts.view() != &request.input.view {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
        if *facts.view_revision() != request.input.expected_view {
            return Err(DomainError::RevisionConflict {
                current: facts.view_revision().clone(),
                lineage: None,
            }
            .into());
        }
        if !facts.after_eligible_in_group() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }

        // Live-room interception (if registered) BEFORE checking closed-room `head_rev_id == expected_note`
        // or staging closed-room CAS blobs.
        let mut reservation_opt = None;
        if let Some(interceptor) = store.inner.collab_interceptor.get() {
            destination_group_rows(&facts, &request.input)?;
            ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
            let mut dispatched = false;
            let response = deadline
                .wait(&ctx.budget, || async {
                    dispatched = true;
                    interceptor
                        .intercept(InterceptedMutation {
                            context: ctx.clone(),
                            identity: request.identity.clone(),
                            preconditions: request.preconditions.clone(),
                            payload: InterceptedPayload::MoveBoardCard {
                                card: request.input.clone(),
                                facts: Box::new(facts.clone()),
                            },
                        })
                        .await
                })
                .await;
            let unknown = |_| {
                crate::codec::unknown_commit_outcome(
                    "board_room_outcome_unknown",
                    "the room may have applied the Board command",
                )
            };
            match response.map_err(|err| if dispatched { unknown(err) } else { err })?? {
                InterceptionResult::Applied(receipt) => {
                    ctx.budget.remaining = deadline.remaining(&ctx.budget).map_err(unknown)?;
                    return deadline
                        .wait(&ctx.budget, || {
                            applied_outcome(
                                store,
                                &ctx,
                                &idemp,
                                receipt,
                                |row: StoredCommittedBoardMoveV1| {
                                    (row.revision.note == request.input.note)
                                        .then(|| row.into_committed())
                                },
                            )
                        })
                        .await
                        .map_err(unknown)??
                        .ok_or_else(super::notes::missing_applied_outcome);
                }
                InterceptionResult::SettleCarrier(_) => {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                InterceptionResult::Conflict(err) => return Err(err.into()),
                InterceptionResult::ClosedRoomReservation(res) => {
                    reservation_opt = Some(res);
                }
            }
        }

        if base_head.head_rev_id != request.input.expected_note {
            return Err(DomainError::RevisionConflict {
                current: base_head.head_rev_id,
                lineage: None,
            }
            .into());
        }

        let base_digest = base_head.content_digest.ok_or_else(|| {
            internal_not_committed(
                "board_move_missing_digest",
                "active note lacks content_blake3",
            )
        })?;
        let raw_bytes = deadline
            .wait(&ctx.budget, || {
                store.read_verified_blob(&space_rec.scope, base_digest)
            })
            .await??;
        let base_carrier = String::from_utf8(raw_bytes).map_err(|_| {
            internal_not_committed(
                "corrupt_note_utf8",
                "canonical note carrier is not valid UTF-8",
            )
        })?;

        let new_carrier = if request.input.fields.is_empty() {
            base_carrier.clone()
        } else {
            let mut edits = Vec::with_capacity(request.input.fields.len());
            for (k, opt_v) in &request.input.fields {
                match opt_v {
                    Some(v) => edits.push(FieldEdit::Set {
                        key: k.clone(),
                        value: v.clone(),
                    }),
                    None => edits.push(FieldEdit::Unset { key: k.clone() }),
                }
            }
            let plan = notarium_syntax::frontmatter::patch_frontmatter(
                &base_carrier,
                base_head.doc_class,
                &edits,
            )?;
            notarium_syntax::patch::apply(&base_carrier, &plan)?
        };

        let carrier_changed = new_carrier != base_carrier;
        let prepared_info_opt = if carrier_changed {
            let info = analyze_and_prepare_carrier(
                &new_carrier,
                base_head.doc_class,
                &request.input.note,
                &base_head.slug,
                store.blob_codec(),
            )?;
            let ticket = deadline
                .wait(&ctx.budget, || {
                    store.stage_blob_for_batch(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        &info.prepared_blob,
                    )
                })
                .await??;
            Some((info, ticket))
        } else {
            None
        };

        let staged_bytes = prepared_info_opt
            .as_ref()
            .map(|(info, _)| info.byte_size)
            .unwrap_or(0);

        let scope_cl = space_rec.scope.clone();
        let auth = ctx.auth().clone();
        let req_id = request.identity.clone();
        let req_prec = request.preconditions.clone();
        let input = request.input.clone();
        let facts_cl = facts.clone();
        let room_fences = store.inner.room_fences.clone();
        let idemp_cl = idemp.clone();

        let intent = PreparedWriteIntent {
            scope: space_rec.scope.clone(),
            active_epoch: space_rec.active_epoch,
            idempotency: Some(idemp_cl),
            source_note_ids: vec![request.input.note.clone(), request.input.view.note.clone()],
            staged_bytes,
            required_semantic_cut: Some((facts.cutoff(), SemanticCutMismatchKind::CursorStale)),
            execute: Box::new(move |tx, item_ctx| {
                Box::pin(async move {
                    // Re-verify target note, view note, auth, and Space schema under writer lock.
                    let head = load_note_head_row_tx(tx, &scope_cl.space_id, &input.note).await?;
                    if head.lifecycle != Lifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let (rfacts, anc) = build_resource_facts_tx(
                        tx,
                        &item_ctx.space,
                        &head.parent_folder_id,
                        head.doc_class,
                        head.ability_id.clone(),
                        true,
                    )
                    .await?;
                    auth.authorize_direct_write(&rfacts, &rfacts)?;
                    let view_head =
                        authorized_view_head(tx, &item_ctx.space, &auth, &input.view.note).await?;
                    let eval_group_rows = destination_group_rows(&facts_cl, &input)?;
                    check_collab_preconditions_tx(tx, &scope_cl.space_id, &input.note, &req_prec)
                        .await?;
                    match reservation_opt {
                        Some(res) => {
                            let g = room_fences
                                .consume_reservation(&scope_cl, &input.note, res, &req_id)
                                .await?;
                            crate::domain::common::durable_note_room_state_tx(
                                tx,
                                &scope_cl.space_id,
                                &input.note,
                            )
                            .await?
                            .require_writable()?;
                            item_ctx.retain_until_batch_commit(g);
                        }
                        None => {
                            if is_note_room_active_tx(tx, &room_fences, &scope_cl, &input.note)
                                .await?
                            {
                                return Err(DomainError::validation(
                                    ValidationReason::InvalidState,
                                )
                                .into());
                            }
                        }
                    }

                    if head.head_rev_id != input.expected_note
                        || req_prec
                            .revision
                            .as_ref()
                            .is_some_and(|r| *r != head.head_rev_id)
                    {
                        return Err(DomainError::RevisionConflict {
                            current: head.head_rev_id,
                            lineage: None,
                        }
                        .into());
                    }
                    if view_head.head_rev_id != input.expected_view {
                        return Err(DomainError::RevisionConflict {
                            current: view_head.head_rev_id,
                            lineage: None,
                        }
                        .into());
                    }

                    let current_schema =
                        load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                    let cur_schema_rev = current_schema.as_ref().map(|s| &s.schema_revision);
                    if cur_schema_rev != facts_cl.schema_revision() {
                        return Err(DomainError::validation(ValidationReason::CursorStale).into());
                    }
                    if let Some(ref cs) = current_schema
                        && cs.descriptor_fingerprint != facts_cl.descriptor_fingerprint()
                    {
                        return Err(DomainError::validation(ValidationReason::CursorStale).into());
                    }

                    // Load existing overlays on this view and check caller + planner rank preconditions.
                    let mut overlays =
                        load_view_overlays_tx(tx, &scope_cl.space_id, &input.view).await?;

                    verify_rank_expectation(
                        &input.expected_rank,
                        overlays.get(&input.note),
                        &head.head_rev_id,
                    )?;
                    // Verify every row in `eval_group_rows` still matches its `expected_note` & `expected_rank`.
                    let mut verified_neighbors = HashMap::with_capacity(eval_group_rows.len());
                    let mut folder_cache = super::common::FolderAncestryCache::default();
                    for row in eval_group_rows {
                        let rhead = verified_board_row_tx(
                            tx,
                            &item_ctx.space,
                            &auth,
                            &mut folder_cache,
                            row,
                        )
                        .await?;
                        verified_neighbors.insert(&row.note, (&row.expected_note, rhead.doc_class));
                        verify_rank_expectation(
                            &row.expected_rank,
                            overlays.get(&row.note),
                            &rhead.head_rev_id,
                        )?;
                    }

                    for neighbor in input.before.iter().chain(&input.after) {
                        verify_rank_expectation(
                            &neighbor.expected_rank,
                            overlays.get(&neighbor.note),
                            &view_head.head_rev_id,
                        )?;
                    }

                    // Build ordered list of existing members in `input.group` excluding `input.note`.
                    // Unranked members from `eval_group_rows` are materialized deterministically in planner order
                    // after any already-ranked members (or evenly spaced if none are ranked yet).
                    let (_, target_gk_hex) = group_key_hex(&input.group)?;
                    let mut group_members: Vec<NoteId> = Vec::new();
                    for row in eval_group_rows {
                        if row.note != input.note {
                            group_members.push(row.note.clone());
                        }
                    }

                    // Separate already-ranked in target group vs unranked in target group.
                    let mut newly_materialized: Vec<(NoteId, String)> = Vec::new();
                    let all_unranked = group_members.iter().all(|nid| {
                        overlays.get(nid).map(|o| &o.group_key_hex) != Some(&target_gk_hex)
                    });

                    let existing_ranked: Vec<ExistingRankedItem> = if group_members.is_empty() {
                        Vec::new()
                    } else if all_unranked {
                        let init_ranks = evenly_spaced_ranks(group_members.len())?;
                        let mut items = Vec::with_capacity(group_members.len());
                        for (nid, r) in group_members.iter().zip(init_ranks) {
                            newly_materialized.push((nid.clone(), r.clone()));
                            items.push(ExistingRankedItem {
                                note_id: nid.clone(),
                                rank: r,
                            });
                        }
                        items
                    } else {
                        // Preserve planner's evaluated order in `eval_group_rows`, assigning monotonic tail ranks
                        // to any unranked rows that follow ranked rows (or gap ranks where needed).
                        let mut items: Vec<ExistingRankedItem> =
                            Vec::with_capacity(group_members.len());
                        // First collect already-ranked members in this group sorted by `(sort_rank_lexo, note_id)`.
                        let mut ranked_only: Vec<ExistingRankedItem> = group_members
                            .iter()
                            .filter_map(|nid| {
                                let o = overlays.get(nid)?;
                                if o.group_key_hex == target_gk_hex {
                                    Some(ExistingRankedItem {
                                        note_id: nid.clone(),
                                        rank: o.sort_rank_lexo.clone(),
                                    })
                                } else {
                                    None
                                }
                            })
                            .collect();
                        ranked_only.sort_by(|x, y| {
                            x.rank.cmp(&y.rank).then_with(|| x.note_id.cmp(&y.note_id))
                        });
                        items.extend(ranked_only);

                        for nid in &group_members {
                            let in_group = overlays
                                .get(nid)
                                .map(|o| o.group_key_hex == target_gk_hex)
                                .unwrap_or(false);
                            if !in_group {
                                let tail = compute_rank_placement(&items, nid, items.len())?;
                                for (pma_nid, pma_rank) in tail.pma_neighbor_updates {
                                    if let Some(existing_item) =
                                        items.iter_mut().find(|it| it.note_id == pma_nid)
                                    {
                                        existing_item.rank = pma_rank.clone();
                                    }
                                    if let Some(mat) =
                                        newly_materialized.iter_mut().find(|(m, _)| *m == pma_nid)
                                    {
                                        mat.1 = pma_rank;
                                    } else {
                                        newly_materialized.push((pma_nid, pma_rank));
                                    }
                                }
                                newly_materialized.push((nid.clone(), tail.target_rank.clone()));
                                items.push(ExistingRankedItem {
                                    note_id: nid.clone(),
                                    rank: tail.target_rank,
                                });
                            }
                        }
                        items
                    };

                    // Determine `insert_index` in `existing_ranked` from `before` ("place before X")
                    // and `after` ("place after Y").
                    let before_idx = match &input.before {
                        Some(b) => Some(
                            existing_ranked
                                .iter()
                                .position(|it| it.note_id == b.note)
                                .ok_or_else(|| {
                                    DomainError::validation(ValidationReason::InvalidState)
                                })?,
                        ),
                        None => None,
                    };
                    let after_idx = match &input.after {
                        Some(a) => Some(
                            existing_ranked
                                .iter()
                                .position(|it| it.note_id == a.note)
                                .ok_or_else(|| {
                                    DomainError::validation(ValidationReason::InvalidState)
                                })?,
                        ),
                        None => None,
                    };

                    let insert_index = match (after_idx, before_idx) {
                        (None, None) => existing_ranked.len(),
                        (None, Some(b_pos)) => b_pos,
                        (Some(a_pos), None) => a_pos + 1,
                        (Some(a_pos), Some(b_pos)) => {
                            if a_pos + 1 != b_pos {
                                return Err(DomainError::validation(
                                    ValidationReason::InvalidState,
                                )
                                .into());
                            }
                            b_pos
                        }
                    };

                    let placement =
                        compute_rank_placement(&existing_ranked, &input.note, insert_index)?;

                    // Deduplicate neighbor updates (`newly_materialized` overridden by final `pma_neighbor_updates` if overlapping).
                    let mut neighbor_final_ranks: BTreeMap<NoteId, (String, bool)> =
                        BTreeMap::new();
                    for (nid, r) in newly_materialized {
                        let was_already_overlay = overlays
                            .get(&nid)
                            .map(|o| o.group_key_hex == target_gk_hex)
                            .unwrap_or(false);
                        neighbor_final_ranks.insert(nid, (r, was_already_overlay));
                    }
                    for (nid, r) in placement.pma_neighbor_updates {
                        neighbor_final_ranks.insert(nid, (r, true));
                    }

                    let predecessor = if insert_index == 0 {
                        None
                    } else {
                        Some(existing_ranked[insert_index - 1].note_id.clone())
                    };
                    let successor = if insert_index >= existing_ranked.len() {
                        None
                    } else {
                        Some(existing_ranked[insert_index].note_id.clone())
                    };

                    let run_opt = extract_agent_run_from_auth(&auth);

                    // Count total SpaceSeq allocations for this atomic command:
                    // (optional 1 for carrier revision) + (N neighbor rank revisions) + (1 target rank revision).
                    let seq_count = u64::from(prepared_info_opt.is_some())
                        + (neighbor_final_ranks.len() as u64)
                        + 1;
                    let (first_seq, visibility_seq) = item_ctx.preview_seq_range(seq_count)?;
                    let now_ts = now_utc_timestamp()?;
                    let (sec, nsec) = encode_timestamp_parts(now_ts);
                    let mut events = Vec::with_capacity(seq_count as usize);

                    // 1. Apply target note carrier revision if fields changed, else keep `head.head_rev_id`.
                    let overlay_eligible = neighbor_final_ranks.len() < EFFECT_MAX_NOTES;
                    let mut summaries = Vec::new();
                    let mut changed_fields = BTreeMap::new();
                    let final_note_rev = if let Some((info, ticket)) = prepared_info_opt {
                        let note_seq = item_ctx.alloc_next_seq()?;
                        let new_rev = new_revision_id()?;
                        let digest = ticket.digest;
                        let claim = BlobReferenceClaim {
                            owner_kind: BlobOwnerKind::NoteRevision,
                            owner_id: input.note.as_str().to_owned(),
                            owner_rev_id: new_rev.as_str().to_owned(),
                            resource_key: "carrier".to_owned(),
                            ticket: ticket.clone(),
                        };
                        item_ctx.record_staged_ticket(ticket);
                        activate_and_bind_blob_ref_tx(
                            tx,
                            &item_ctx.scope,
                            item_ctx.active_epoch,
                            &claim,
                            note_seq,
                        )
                        .await?;
                        crate::domain::common::sync_closed_collab_session_on_direct_write_tx(
                            tx,
                            &scope_cl.space_id,
                            &input.note,
                            &new_rev,
                            visibility_seq,
                        )
                        .await?;

                        let vis_i64 = visibility_seq.get() as i64;
                        match tx {
                            BackendConn::Sqlite(conn) => {
                                sqlx::query(
                                    "UPDATE note_heads
                                     SET title = ?, title_fold = ?, head_rev_id = ?, content_blake3 = ?,
                                         byte_size = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?,
                                         last_actor_id = ?
                                     WHERE space_id = ? AND note_id = ?",
                                )
                                .bind(&info.title)
                                .bind(&info.title_fold)
                                .bind(new_rev.as_str())
                                .bind(digest.as_bytes().as_slice())
                                .bind(info.byte_size as i64)
                                .bind(vis_i64)
                                .bind(sec)
                                .bind(nsec)
                                .bind(auth.principal().as_str())
                                .bind(scope_cl.space_id.as_str())
                                .bind(input.note.as_str())
                                .execute(&mut **conn)
                                .await
                                .map_err(|err| {
                                    internal_not_committed("sqlite_board_upd_note", err.to_string())
                                })?;
                            }
                            BackendConn::Postgres(conn) => {
                                sqlx::query(
                                    "UPDATE note_heads
                                     SET title = $1, title_fold = $2, head_rev_id = $3, content_blake3 = $4,
                                         byte_size = $5, updated_seq = $6, updated_at_sec = $7, updated_at_nsec = $8,
                                         last_actor_id = $9
                                     WHERE space_id = $10 AND note_id = $11",
                                )
                                .bind(&info.title)
                                .bind(&info.title_fold)
                                .bind(new_rev.as_str())
                                .bind(digest.as_bytes().as_slice())
                                .bind(info.byte_size as i64)
                                .bind(vis_i64)
                                .bind(sec)
                                .bind(nsec)
                                .bind(auth.principal().as_str())
                                .bind(scope_cl.space_id.as_str())
                                .bind(input.note.as_str())
                                .execute(&mut **conn)
                                .await
                                .map_err(|err| {
                                    internal_not_committed("pg_board_upd_note", err.to_string())
                                })?;
                            }
                        }

                        let eval_fields = evaluate_fields_with_schema(
                            info.raw_fields.as_ref(),
                            info.diagnostics.first(),
                            current_schema.as_ref().map(|s| &s.fields),
                        );
                        if overlay_eligible {
                            changed_fields = changed_revision_fields_tx(
                                tx,
                                &scope_cl,
                                &head.head_rev_id,
                                &eval_fields,
                            )
                            .await?;
                        }
                        let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                            NoteRevisionMetadata {
                                note_id: input.note.clone(),
                                parent_folder_id: head.parent_folder_id.clone(),
                                is_root_child: anc.is_root_child,
                                slug: head.slug.clone(),
                                slug_fold: head.slug_fold.clone(),
                                title: info.title,
                                doc_class: head.doc_class,
                                ability_id: head.ability_id.clone(),
                                lifecycle: Lifecycle::Active,
                                visibility_mask: head.visibility_mask,
                                byte_size: info.byte_size,
                                content_digest: Some(digest),
                                schema_revision: current_schema
                                    .as_ref()
                                    .map(|s| s.schema_revision.clone()),
                                raw_fields: info.raw_fields,
                                evaluated_fields: eval_fields,
                                diagnostics: info.diagnostics,
                            },
                        ))
                        .encode()?;

                        insert_revision_row(
                            tx,
                            &scope_cl,
                            &new_rev,
                            "note",
                            input.note.as_str(),
                            note_seq,
                            visibility_seq,
                            Some(&head.head_rev_id),
                            None,
                            Some(digest),
                            &meta,
                            auth.principal(),
                            run_opt.as_ref(),
                            now_ts,
                        )
                        .await?;

                        events.push(BatchEventDraft {
                            space_seq: note_seq,
                            entity_type: "note".to_owned(),
                            entity_id: input.note.as_str().to_owned(),
                            op_kind: "edit".to_owned(),
                            rev_id: new_rev.clone(),
                            lifecycle: Lifecycle::Active,
                            doc_class: Some(head.doc_class),
                        });
                        new_rev
                    } else {
                        head.head_rev_id.clone()
                    };

                    // 2. Persist neighbor materializations / Window PMA normalizations.
                    for (nbr_id, (nbr_rank, is_pma)) in &neighbor_final_ranks {
                        let nbr_seq = item_ctx.alloc_next_seq()?;
                        let nbr_rank_rev = new_revision_id()?;
                        let existing_ov = overlays.get(nbr_id);
                        let (pl_rev, pl_actor, pl_run) = match existing_ov {
                            Some(ov) => (
                                ov.placement_revision.clone(),
                                ov.placement_actor_id.clone(),
                                ov.placement_run_id.clone(),
                            ),
                            None => (nbr_rank_rev.clone(), auth.principal().clone(), None),
                        };
                        upsert_overlay_and_rank_revision_tx(
                            tx,
                            &scope_cl,
                            &input.view,
                            nbr_id,
                            &input.group,
                            nbr_rank,
                            &nbr_rank_rev,
                            existing_ov.map(|o| &o.rank_rev_id),
                            &pl_rev,
                            &pl_actor,
                            pl_run.as_ref(),
                            auth.principal(),
                            run_opt.as_ref(),
                            *is_pma,
                            nbr_seq,
                            visibility_seq,
                            now_ts,
                        )
                        .await?;
                        if overlay_eligible {
                            let &(revision, doc_class) =
                                verified_neighbors.get(nbr_id).ok_or_else(|| {
                                    DomainError::validation(ValidationReason::InvalidState)
                                })?;
                            let rank = format!(
                                "{}:{}:{}",
                                input.view.note.as_str(),
                                input.view.key.as_str(),
                                nbr_rank_rev.as_str()
                            );
                            summaries.push(ChangedNoteSummaryV1 {
                                note_id: nbr_id.clone(),
                                revision: revision.clone(),
                                rank_version: note_rank_version_digest(revision, Some(&rank)),
                                lifecycle: Lifecycle::Active,
                                doc_class,
                                changed_fields: BTreeMap::new(),
                            });
                        }
                        events.push(BatchEventDraft {
                            space_seq: nbr_seq,
                            entity_type: "note".to_owned(),
                            entity_id: nbr_id.as_str().to_owned(),
                            op_kind: "move".to_owned(),
                            rev_id: nbr_rank_rev,
                            lifecycle: Lifecycle::Active,
                            doc_class: None,
                        });
                    }

                    // 3. Persist target card's new overlay + rank revision + semantic placement revision.
                    let target_rank_seq = item_ctx.alloc_next_seq()?;
                    let target_rank_rev = new_revision_id()?;
                    let target_placement_rev = new_revision_id()?;
                    let prior_target_ov = overlays.remove(&input.note);
                    let before_placement_rev = prior_target_ov
                        .as_ref()
                        .map(|o| o.placement_revision.clone());

                    upsert_overlay_and_rank_revision_tx(
                        tx,
                        &scope_cl,
                        &input.view,
                        &input.note,
                        &input.group,
                        &placement.target_rank,
                        &target_rank_rev,
                        prior_target_ov.as_ref().map(|o| &o.rank_rev_id),
                        &target_placement_rev,
                        auth.principal(),
                        run_opt.as_ref(),
                        auth.principal(),
                        run_opt.as_ref(),
                        false,
                        target_rank_seq,
                        visibility_seq,
                        now_ts,
                    )
                    .await?;
                    events.push(BatchEventDraft {
                        space_seq: target_rank_seq,
                        entity_type: "note".to_owned(),
                        entity_id: input.note.as_str().to_owned(),
                        op_kind: "move".to_owned(),
                        rev_id: target_rank_rev.clone(),
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(head.doc_class),
                    });

                    // 4. Bump `agent_run_heads` if executed by an agent run (at `visibility_seq` in `revisions`).
                    if let Some(ref run_id) = run_opt {
                        upsert_agent_run_head_tx(
                            tx,
                            &scope_cl,
                            run_id,
                            auth.principal(),
                            visibility_seq,
                            visibility_seq,
                            now_ts,
                        )
                        .await?;
                    }

                    // 5. Append semantic `board_move_history` + `payload_owners` for Purge erasure & Rollback replay.
                    let before_stored =
                        StoredSemanticPlacementV1::from(facts_cl.before_placement());
                    let after_stored = StoredSemanticPlacementV1::InGroup {
                        group: input.group.clone(),
                        predecessor,
                        successor,
                    };
                    let before_msgpack = encode_msgpack(&before_stored)?;
                    let after_msgpack = encode_msgpack(&after_stored)?;
                    let before_json = input
                        .before
                        .as_ref()
                        .map(|n| (n.note.as_str(), &n.expected_rank));
                    let after_json = input
                        .after
                        .as_ref()
                        .map(|n| (n.note.as_str(), &n.expected_rank));
                    let phys_prec_json = serde_json::json!({
                        "expected_note": input.expected_note.as_str(),
                        "expected_view": input.expected_view.as_str(),
                        "expected_rank": &input.expected_rank,
                        "before": before_json,
                        "after": after_json,
                    })
                    .to_string();

                    insert_board_move_history_tx(
                        tx,
                        &scope_cl,
                        visibility_seq,
                        0,
                        facts_cl.cutoff(),
                        auth.principal(),
                        run_opt.as_ref(),
                        &input.view,
                        &input.expected_view,
                        facts_cl.schema_revision(),
                        &facts_cl.descriptor_fingerprint(),
                        &input.note,
                        before_placement_rev.as_ref(),
                        &target_placement_rev,
                        &target_rank_rev,
                        &phys_prec_json,
                        &before_msgpack,
                        &after_msgpack,
                        &facts_cl.base_order_binding(),
                    )
                    .await?;

                    // 6. Build receipt & change effect payload.
                    let command_id = new_prefixed_hex_id("cmd_")?;
                    let extra_digest = format!(
                        "{}:{}:{}",
                        input.view.note.as_str(),
                        input.view.key.as_str(),
                        target_rank_rev.as_str()
                    );
                    let rank_ver = note_rank_version_digest(&final_note_rev, Some(&extra_digest));
                    let cmd_range =
                        notarium_core::ports::CommandSeqRange::new(first_seq, visibility_seq)?;
                    let effect_body = if overlay_eligible {
                        summaries.push(ChangedNoteSummaryV1 {
                            note_id: input.note.clone(),
                            revision: final_note_rev.clone(),
                            rank_version: rank_ver,
                            lifecycle: Lifecycle::Active,
                            doc_class: head.doc_class,
                            changed_fields,
                        });
                        EffectBodyV1::Notes { notes: summaries }
                    } else {
                        EffectBodyV1::AwaitProjection {
                            reason: StoredAwaitReasonV1::TooManyNotes,
                        }
                    };
                    let mut owners: Vec<_> = neighbor_final_ranks.into_keys().collect();
                    owners.extend([input.note.clone(), input.view.note.clone()]);
                    let effect_draft = build_effect_payload_draft(
                        new_prefixed_hex_id("pay_")?,
                        scope_cl.clone(),
                        cmd_range,
                        "move_board_card",
                        effect_body,
                        owners,
                    )?;

                    let receipt_token =
                        MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
                    let wire = StoredCommittedBoardMoveV1 {
                        revision: NoteRevision {
                            note: input.note.clone(),
                            revision: final_note_rev,
                        },
                        rank_revision: target_rank_rev,
                        group: input.group,
                        rank: placement.target_rank,
                        receipt: receipt_token,
                    };
                    let resp_bytes = encode_msgpack(&wire)?;
                    let sanitized = encode_msgpack(&wire.receipt)?;

                    Ok(ItemCommitArtifacts {
                        command_id,
                        command_kind: "move_board_card".to_owned(),
                        events,
                        change_payload: Some(effect_draft),
                        receipt_detail_blob: Some(resp_bytes.clone()),
                        receipt_sanitized_blob: sanitized,
                        receipt_owner_note_ids: vec![input.note, input.view.note],
                        response_bytes: resp_bytes,
                    })
                })
            }),
        };

        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        match store
            .submit_write_command_until::<StoredCommittedBoardMoveV1>(
                &ctx.budget,
                deadline.at,
                intent,
                None,
                None,
                None,
            )
            .await
        {
            Ok(decoded) => {
                return Ok(decoded.into_committed());
            }
            Err(PortError::Domain(DomainError::ValidationFailed {
                diagnostic:
                    Diagnostic {
                        reason: ValidationReason::CursorStale,
                        ..
                    },
            })) if attempt + 1 < MAX_PLANNER_RETRIES => {
                continue;
            }
            Err(err) => return Err(err),
        }
    }

    Err(unavailable_retryable(
        "board_planner_cut_contention",
        "board facts cutoff contended across bounded retries",
        std::time::Duration::from_millis(10),
    ))
}

pub(crate) async fn verified_board_row_tx(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    folders: &mut super::common::FolderAncestryCache,
    row: &EvaluatedBoardRow,
) -> Result<super::common::NoteHeadRow, PortError> {
    let head = load_note_head_row_tx(tx, &space.id, &row.note).await?;
    if head.lifecycle != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let (facts, _) = folders
        .build_resource_facts_tx(
            tx,
            space,
            &head.parent_folder_id,
            head.doc_class,
            head.ability_id.clone(),
            true,
        )
        .await?;
    auth.authorize_read(&facts)?;
    if head.head_rev_id != row.expected_note {
        return Err(DomainError::RevisionConflict {
            current: head.head_rev_id,
            lineage: None,
        }
        .into());
    }
    Ok(head)
}

pub(crate) async fn authorized_view_head(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    view: &NoteId,
) -> Result<super::common::NoteHeadRow, PortError> {
    let head = load_note_head_row_tx(tx, &space.id, view).await?;
    if head.lifecycle != Lifecycle::Active
        || is_note_purge_fenced_tx(tx, &space.id, view.as_str()).await?
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let (facts, _) = build_resource_facts_tx(
        tx,
        space,
        &head.parent_folder_id,
        head.doc_class,
        head.ability_id.clone(),
        true,
    )
    .await?;
    auth.authorize_read(&facts)?;
    Ok(head)
}

fn build_move_board_card_identity_spec(
    request: &Mutation<MoveBoardCard>,
) -> Result<crate::writer::replay::UnboundCommand, PortError> {
    let mut fp = blake3::Hasher::new();
    fp.update(request.input.view.note.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.view.key.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.note.as_str().as_bytes());
    fp.update(&[0]);
    let (gk_bytes, _) = group_key_hex(&request.input.group)?;
    fp.update(&gk_bytes);
    fp.update(&[0]);
    let before_fp = request
        .input
        .before
        .as_ref()
        .map(|n| (n.note.as_str(), &n.expected_rank));
    let after_fp = request
        .input
        .after
        .as_ref()
        .map(|n| (n.note.as_str(), &n.expected_rank));
    let prec_bytes = serde_json::to_vec(&(
        before_fp,
        after_fp,
        &request.input.fields,
        &request.input.expected_note,
        &request.input.expected_view,
        &request.input.expected_rank,
    ))
    .map_err(|err| internal_not_committed("board_move_fp_json", err.to_string()))?;
    fp.update(&prec_bytes);
    Ok(derive_command_identity_spec(
        &request.identity,
        "move_board_card",
        fp.finalize().as_bytes(),
    )
    .with_preconditions(&request.preconditions, "note", request.input.note.as_str())
    .with_known_base(&request.input.expected_note))
}

#[allow(clippy::too_many_arguments)]
async fn insert_board_move_history_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    command_end_seq: SpaceSeq,
    ordinal: i32,
    facts_cutoff_seq: SpaceSeq,
    actor_id: &PrincipalId,
    agent_run_id: Option<&AgentRunId>,
    view: &ViewRef,
    view_rev_id: &RevisionId,
    schema_rev_id: Option<&RevisionId>,
    descriptor_fingerprint: &ContentDigest,
    target_note_id: &NoteId,
    before_placement_revision: Option<&RevisionId>,
    after_placement_revision: &RevisionId,
    after_rank_rev_id: &RevisionId,
    physical_precondition_json: &str,
    before_placement_msgpack: &[u8],
    after_placement_msgpack: &[u8],
    base_order_binding: &ContentDigest,
) -> Result<(), PortError> {
    let end_i64 = command_end_seq.get() as i64;
    let cut_i64 = facts_cutoff_seq.get() as i64;
    let run_str = agent_run_id.map(AgentRunId::as_str);
    let schema_str = schema_rev_id.map(RevisionId::as_str);
    let before_prev_str = before_placement_revision.map(RevisionId::as_str);
    let payload_id = format!("{}:{ordinal}", command_end_seq.get());

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO board_move_history (
                    space_id, history_incarnation, command_end_seq, ordinal, facts_cutoff_seq,
                    actor_id, agent_run_id, view_note_id, view_key, view_rev_id, schema_rev_id,
                    descriptor_fingerprint, target_note_id, before_placement_revision,
                    after_placement_revision, after_rank_rev_id, physical_precondition_json,
                    before_placement_msgpack, after_placement_msgpack, base_order_binding
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(end_i64)
            .bind(i64::from(ordinal))
            .bind(cut_i64)
            .bind(actor_id.as_str())
            .bind(run_str)
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .bind(view_rev_id.as_str())
            .bind(schema_str)
            .bind(descriptor_fingerprint.as_bytes().as_slice())
            .bind(target_note_id.as_str())
            .bind(before_prev_str)
            .bind(after_placement_revision.as_str())
            .bind(after_rank_rev_id.as_str())
            .bind(physical_precondition_json)
            .bind(before_placement_msgpack)
            .bind(after_placement_msgpack)
            .bind(base_order_binding.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_bmh", err.to_string()))?;

            for owner in [target_note_id, &view.note] {
                sqlx::query(
                    "INSERT OR IGNORE INTO payload_owners (space_id, payload_kind, payload_id, note_id)
                     VALUES (?, 'board_move_history', ?, ?)",
                )
                .bind(scope.space_id.as_str())
                .bind(&payload_id)
                .bind(owner.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_insert_bmh_owner", err.to_string()))?;
            }
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO board_move_history (
                    space_id, history_incarnation, command_end_seq, ordinal, facts_cutoff_seq,
                    actor_id, agent_run_id, view_note_id, view_key, view_rev_id, schema_rev_id,
                    descriptor_fingerprint, target_note_id, before_placement_revision,
                    after_placement_revision, after_rank_rev_id, physical_precondition_json,
                    before_placement_msgpack, after_placement_msgpack, base_order_binding
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(end_i64)
            .bind(ordinal)
            .bind(cut_i64)
            .bind(actor_id.as_str())
            .bind(run_str)
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .bind(view_rev_id.as_str())
            .bind(schema_str)
            .bind(descriptor_fingerprint.as_bytes().as_slice())
            .bind(target_note_id.as_str())
            .bind(before_prev_str)
            .bind(after_placement_revision.as_str())
            .bind(after_rank_rev_id.as_str())
            .bind(physical_precondition_json)
            .bind(before_placement_msgpack)
            .bind(after_placement_msgpack)
            .bind(base_order_binding.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_bmh", err.to_string()))?;

            for owner in [target_note_id, &view.note] {
                sqlx::query(
                    "INSERT INTO payload_owners (space_id, payload_kind, payload_id, note_id)
                     VALUES ($1, 'board_move_history', $2, $3)
                     ON CONFLICT DO NOTHING",
                )
                .bind(scope.space_id.as_str())
                .bind(&payload_id)
                .bind(owner.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_insert_bmh_owner", err.to_string()))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexo_rank_10k_first_slot_moves_stay_within_16_bytes_and_strict_order() {
        let seed_a = NoteId::from_bytes([1u8; 16]);
        let seed_b = NoteId::from_bytes([2u8; 16]);
        let init = evenly_spaced_ranks(2).expect("initial ranks");
        let mut items = vec![
            ExistingRankedItem {
                note_id: seed_a,
                rank: init[0].clone(),
            },
            ExistingRankedItem {
                note_id: seed_b,
                rank: init[1].clone(),
            },
        ];

        let mut total_pma_updates = 0usize;
        for step in 0..10_000u32 {
            // Alternate inserting a new card vs moving the tail card to slot 0 so both growing
            // groups and fixed-membership churn are exercised!
            let target = if step % 2 == 0 {
                let mut id_bytes = [0u8; 16];
                id_bytes[12..16].copy_from_slice(&(step + 100).to_be_bytes());
                NoteId::from_bytes(id_bytes)
            } else {
                items.pop().expect("non-empty").note_id
            };

            let res = compute_rank_placement(&items, &target, 0).expect("slot 0 placement");
            assert!(
                !res.target_rank.is_empty() && res.target_rank.len() <= 16,
                "rank exceeded 16 bytes at step {step}: {}",
                res.target_rank
            );
            total_pma_updates += res.pma_neighbor_updates.len();

            if !res.pma_neighbor_updates.is_empty() {
                let upd_map: HashMap<NoteId, String> =
                    res.pma_neighbor_updates.into_iter().collect();
                for it in &mut items {
                    if let Some(new_r) = upd_map.get(&it.note_id) {
                        assert!(new_r.len() <= 16);
                        it.rank = new_r.clone();
                    }
                }
            }
            items.insert(
                0,
                ExistingRankedItem {
                    note_id: target,
                    rank: res.target_rank,
                },
            );

            // Spot-check strict total order across the prefix on every iteration and full slice periodically.
            assert!(items[0].rank < items[1].rank, "order broken at step {step}");
            if step % 1_000 == 999 {
                for pair in items.windows(2) {
                    assert!(pair[0].rank < pair[1].rank);
                }
            }
        }

        for pair in items.windows(2) {
            assert!(pair[0].rank < pair[1].rank);
            assert!(pair[0].rank.len() <= 16);
        }
        // Amortized neighbor updates across 10,000 worst-case slot-0 moves should remain tiny (< 5 per move).
        assert!(
            total_pma_updates < 50_000,
            "unexpectedly high PMA churn: {total_pma_updates}"
        );
    }
}
