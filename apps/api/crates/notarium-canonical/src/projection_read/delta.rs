use std::collections::BTreeSet;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{AbilityId, FolderId, NoteId, RevisionId, SpaceSeq},
    model::HistoryScope,
    ports::{MaintenanceContext, PageLimit},
};

use crate::{
    CanonicalStore,
    codec::{
        RevisionMetadataEnvelope, RevisionMetadataPayload, i64_to_space_seq, internal_not_committed,
    },
    projection_chat::{ProjectionChatHead, read_heads_batch},
    runtime::{pg_read_error, purge_fenced_note_ids_tx, require_command_end_tx},
    sql_exec::BackendConn,
};

use super::{
    ProjectedSchemaSnapshot, ProjectionAlias, ProjectionFolder, ProjectionNote, ProjectionPage,
    ProjectionRank, aliases::aliases_in_range, checked_cut, corrupt, folders_at_batch,
    notes_at_batch, ranks::decode_rank, schema_at, stale, truncate_page,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionDelta {
    Note(Box<ProjectionNote>),
    Folder(ProjectionFolder),
    Thread(ProjectionChatHead),
    Rank {
        rank: ProjectionRank,
        changes_placement: bool,
    },
    Ability(ProjectionAbility),
    Schema(Option<ProjectedSchemaSnapshot>),
    Alias(ProjectionAlias),
    Purge(NoteId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionAbility {
    pub ability_id: AbilityId,
    pub entrypoint_note_id: NoteId,
    pub revision_id: RevisionId,
    pub visibility_seq: SpaceSeq,
    pub note: Option<Box<ProjectionNote>>,
}

type ChangeRow = (
    i64,
    i64,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<Vec<u8>>,
);

impl CanonicalStore {
    /// Returns one page of effects inside an already delimited command range.
    ///
    /// The outer bounds must be command ends. The page key is the last examined
    /// event, so an empty effect page can still advance inside a large command.
    pub async fn read_projection_delta_batch(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        after: SpaceSeq,
        through: SpaceSeq,
        page_after: Option<SpaceSeq>,
        limit: PageLimit,
    ) -> Result<ProjectionPage<ProjectionDelta, SpaceSeq>, PortError> {
        let scope = scope.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                let cursor = page_after.unwrap_or(after);
                if cursor < after || cursor > through {
                    return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
                }
                checked_cut(tx, &scope, through).await?;
                require_command_end_tx(tx, &scope, after).await?;
                let mut changes = page_changes(tx, &scope, cursor, through, limit).await?;
                let more = truncate_page(&mut changes, limit);
                let end = match changes.last() {
                    Some(change) if more => i64_to_space_seq(change.0)?,
                    _ => through,
                };
                let mut rows = effects_from_changes_batch(tx, &scope, through, changes).await?;
                if schema_changed_in_range(tx, &scope, cursor, end).await? {
                    rows.push(ProjectionDelta::Schema(
                        schema_at(tx, &scope, through).await?,
                    ));
                }
                rows.extend(
                    aliases_in_range(tx, &scope, cursor, end)
                        .await?
                        .into_iter()
                        .map(ProjectionDelta::Alias),
                );
                Ok(ProjectionPage {
                    rows,
                    next: more.then_some(end),
                })
            })
        })
        .await
    }
}

async fn page_changes(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cursor: SpaceSeq,
    through: SpaceSeq,
    limit: PageLimit,
) -> Result<Vec<ChangeRow>, PortError> {
    const SQL: &str = "SELECT e.space_seq, e.command_last_seq, e.entity_type, e.entity_id, e.op_kind, e.rev_id,
            e.doc_class, r.entity_type, r.visibility_seq, r.metadata_msgpack
        FROM change_log e
        LEFT JOIN revisions r ON r.space_id = e.space_id AND r.history_incarnation = e.history_incarnation
          AND r.rev_id = e.rev_id AND r.entity_type IN ('ability', 'rank')
        WHERE e.space_id = $1 AND e.history_incarnation = $2 AND e.space_seq > $3 AND e.space_seq <= $4
        ORDER BY e.space_seq LIMIT $5";
    read_rows!(
        tx,
        fetch_all,
        "projection_delta_page",
        ChangeRow,
        SQL,
        scope.space_id.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        cursor.get() as i64,
        through.get() as i64,
        i64::from(limit.get()) + 1,
    )
}

enum ParsedChange {
    Purge(NoteId),
    Rank {
        rank: ProjectionRank,
        changes_placement: bool,
    },
    Note(NoteId),
    Folder(FolderId),
    AbilityMissing(String),
    Ability {
        ability_id: AbilityId,
        entrypoint_note_id: NoteId,
        revision_id: RevisionId,
        visibility_seq: SpaceSeq,
    },
    Thread(String),
    Skip,
}

async fn effects_from_changes_batch(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    through: SpaceSeq,
    changes: Vec<ChangeRow>,
) -> Result<Vec<ProjectionDelta>, PortError> {
    let mut parsed = Vec::with_capacity(changes.len());
    let mut rank_notes = BTreeSet::new();
    let mut note_ids = BTreeSet::new();
    let mut folder_ids = BTreeSet::new();
    let mut thread_ids = BTreeSet::new();
    let mut missing_abilities = BTreeSet::new();

    for (seq, command_last_seq, entity_type, id, op, rev, doc_class, rev_type, visible, metadata) in
        changes
    {
        if entity_type == "note" && op == "purge" {
            parsed.push(ParsedChange::Purge(NoteId::parse(&id)?));
            continue;
        }
        if let Some("rank") = rev_type.as_deref() {
            let rank = decode_rank(
                rev,
                visible.ok_or_else(stale)?,
                &metadata.ok_or_else(stale)?,
            )?;
            rank_notes.insert(rank.metadata.view_note_id.clone());
            rank_notes.insert(rank.metadata.target_note_id.clone());
            // Board moves write the commanded card last with a non-null doc_class;
            // neighbor materializations (including rollback neighbor moves when
            // planned_target_restores is empty) omit doc_class.
            let changes_placement = rank.metadata.removed
                || op == "restore"
                || (op == "move"
                    && seq == command_last_seq
                    && !rank.metadata.is_pma_normalization
                    && doc_class.is_some());
            parsed.push(ParsedChange::Rank {
                rank,
                changes_placement,
            });
            continue;
        }
        match entity_type.as_str() {
            "note" => {
                let id = NoteId::parse(&id)?;
                note_ids.insert(id.clone());
                parsed.push(ParsedChange::Note(id));
            }
            "folder" => {
                let id = FolderId::parse(&id)?;
                folder_ids.insert(id.clone());
                parsed.push(ParsedChange::Folder(id));
            }
            "ability" => {
                let Some(bytes) = metadata else {
                    missing_abilities.insert(id.clone());
                    parsed.push(ParsedChange::AbilityMissing(id));
                    continue;
                };
                let RevisionMetadataPayload::Ability(ability) =
                    RevisionMetadataEnvelope::decode(&bytes)?.payload
                else {
                    return Err(corrupt("expected an ability delta revision"));
                };
                if ability.ability_id.as_str() != id {
                    return Err(corrupt("ability delta identity does not match its event"));
                }
                note_ids.insert(ability.entrypoint_note_id.clone());
                parsed.push(ParsedChange::Ability {
                    ability_id: ability.ability_id,
                    entrypoint_note_id: ability.entrypoint_note_id,
                    revision_id: RevisionId::parse(&rev)?,
                    visibility_seq: i64_to_space_seq(visible.ok_or_else(stale)?)?,
                });
            }
            "thread" => {
                thread_ids.insert(id.clone());
                parsed.push(ParsedChange::Thread(id));
            }
            "job" => parsed.push(ParsedChange::Skip),
            _ => return Err(corrupt("unexpected delta entity type")),
        }
    }

    let fenced_rank_notes = if rank_notes.is_empty() {
        Default::default()
    } else {
        let vec: Vec<NoteId> = rank_notes.into_iter().collect();
        purge_fenced_note_ids_tx(tx, &scope.space_id, &vec).await?
    };
    let notes_map = if note_ids.is_empty() {
        Default::default()
    } else {
        let vec: Vec<NoteId> = note_ids.into_iter().collect();
        notes_at_batch(tx, scope, through, &vec).await?
    };
    let folders_map = if folder_ids.is_empty() {
        Default::default()
    } else {
        let vec: Vec<FolderId> = folder_ids.into_iter().collect();
        folders_at_batch(tx, scope, through, &vec).await?
    };
    let threads_map = if thread_ids.is_empty() {
        Default::default()
    } else {
        let vec: Vec<String> = thread_ids.into_iter().collect();
        read_heads_batch(tx, scope, through, &vec).await?
    };
    let purged_abilities = if missing_abilities.is_empty() {
        Default::default()
    } else {
        let vec: Vec<String> = missing_abilities.into_iter().collect();
        purged_abilities_batch(tx, scope, &vec).await?
    };

    let mut rows = Vec::with_capacity(parsed.len());
    for item in parsed {
        match item {
            ParsedChange::Purge(id) => rows.push(ProjectionDelta::Purge(id)),
            ParsedChange::Rank {
                rank,
                changes_placement,
            } => {
                if fenced_rank_notes.contains(&rank.metadata.view_note_id)
                    || fenced_rank_notes.contains(&rank.metadata.target_note_id)
                {
                    continue;
                }
                rows.push(ProjectionDelta::Rank {
                    rank,
                    changes_placement,
                });
            }
            ParsedChange::Note(id) => {
                if let Some(note) = notes_map.get(&id) {
                    rows.push(ProjectionDelta::Note(Box::new(note.clone())));
                }
            }
            ParsedChange::Folder(id) => {
                if let Some(folder) = folders_map.get(&id) {
                    rows.push(ProjectionDelta::Folder(folder.clone()));
                }
            }
            ParsedChange::AbilityMissing(id) => {
                if !purged_abilities.contains(&id) {
                    return Err(stale());
                }
            }
            ParsedChange::Ability {
                ability_id,
                entrypoint_note_id,
                revision_id,
                visibility_seq,
            } => {
                let note = notes_map.get(&entrypoint_note_id).cloned().map(Box::new);
                rows.push(ProjectionDelta::Ability(ProjectionAbility {
                    ability_id,
                    entrypoint_note_id,
                    revision_id,
                    visibility_seq,
                    note,
                }));
            }
            ParsedChange::Thread(id) => {
                if let Some(head) = threads_map.get(&id) {
                    rows.push(ProjectionDelta::Thread(head.clone()));
                }
            }
            ParsedChange::Skip => {}
        }
    }
    Ok(rows)
}

async fn purged_abilities_batch(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    ability_ids: &[String],
) -> Result<BTreeSet<String>, PortError> {
    let mut out = BTreeSet::new();
    let space = scope.space_id.as_str();
    match tx {
        BackendConn::Postgres(conn) => {
            let ids: Vec<&str> = ability_ids.iter().map(String::as_str).collect();
            let rows: Vec<String> = sqlx::query_scalar(
                "SELECT ability_id FROM ability_packages
                 WHERE space_id = $1 AND ability_id = ANY($2)
                   AND (lifecycle_state = 'purged' OR EXISTS(
                       SELECT 1 FROM revision_purge_fences p
                       WHERE p.space_id = ability_packages.space_id
                         AND p.note_id = ability_packages.entrypoint_note_id
                   ))",
            )
            .bind(space)
            .bind(&ids)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_projection_abilities_purged", err))?;
            out.extend(rows);
        }
        BackendConn::Sqlite(conn) => {
            for chunk in ability_ids.chunks(200) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT ability_id FROM ability_packages WHERE space_id = ",
                );
                qb.push_bind(space).push(" AND ability_id IN (");
                let mut sep = qb.separated(", ");
                for id in chunk {
                    sep.push_bind(id.as_str());
                }
                sep.push_unseparated(
                    ") AND (lifecycle_state = 'purged' OR EXISTS(
                        SELECT 1 FROM revision_purge_fences p
                        WHERE p.space_id = ability_packages.space_id
                          AND p.note_id = ability_packages.entrypoint_note_id
                    ))",
                );
                let rows: Vec<String> = qb
                    .build_query_scalar()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed(
                            "sqlite_projection_abilities_purged",
                            err.to_string(),
                        )
                    })?;
                out.extend(rows);
            }
        }
    }
    Ok(out)
}

async fn schema_changed_in_range(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    after: SpaceSeq,
    through: SpaceSeq,
) -> Result<bool, PortError> {
    const SQL: &str = "SELECT EXISTS (
            SELECT 1 FROM space_field_schemas
            WHERE space_id = $1 AND visibility_seq > $2 AND visibility_seq <= $3
        )";
    let (changed,) = read_rows!(
        tx,
        fetch_one,
        "projection_schema_delta",
        (bool,),
        SQL,
        scope.space_id.as_str(),
        after.get() as i64,
        through.get() as i64,
    )?;
    Ok(changed)
}
