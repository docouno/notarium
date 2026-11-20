use super::*;

pub(super) fn retain_binding(
    meta: &mut NoteRevisionMetadata,
    head: &NoteHeadRow,
) -> Result<(), PortError> {
    if meta.ability_id.is_some() && meta.ability_id != head.ability_id
        || head.ability_id.is_some() && meta.doc_class != DocClass::Skill
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    // The immutable note revision immediately before publication did not contain its binding.
    meta.ability_id.clone_from(&head.ability_id);
    Ok(())
}

pub(super) async fn has_later_foreign_publication(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    head: &NoteHeadRow,
    first_run_seq: SpaceSeq,
    run: &AgentRunId,
    created_note: bool,
) -> Result<bool, PortError> {
    // Publication has its own revision stream. Renames and lifecycle changes only update the
    // package row; its updated_seq cannot distinguish them from actual manifest publication.
    let sql = "SELECT p.ability_id, p.lifecycle_state, tip.space_seq, EXISTS (
          SELECT 1 FROM revisions r WHERE r.space_id=p.space_id AND r.history_incarnation=$3
          AND r.entity_type='ability' AND r.entity_key=p.ability_id AND r.visibility_seq >= $4
          AND r.space_seq >= $4 AND (r.agent_run_id IS NULL OR r.agent_run_id <> $5)
        ) FROM ability_packages p LEFT JOIN revisions tip ON tip.space_id=p.space_id
          AND tip.history_incarnation=$3 AND tip.rev_id=p.manifest_rev_id
          AND tip.entity_type='ability' AND tip.entity_key=p.ability_id
        WHERE p.space_id=$1 AND p.entrypoint_note_id=$2 LIMIT 2";
    let first = first_run_seq.get() as i64;
    let rows: Vec<(String, String, Option<i64>, bool)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(sql)
                .bind(scope.space_id.as_str())
                .bind(head.note_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(first)
                .bind(run.as_str())
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(sql)
                .bind(scope.space_id.as_str())
                .bind(head.note_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(first)
                .bind(run.as_str())
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|err| crate::runtime::pg_read_error("rollback_ability_publication", err))?;
    match (rows.as_slice(), &head.ability_id) {
        ([], None) => Ok(false),
        ([(id, lifecycle, Some(published), foreign)], Some(ability))
            if ability.as_str() == id && lifecycle != "purged" =>
        {
            if *foreign {
                return Ok(true);
            }
            if *published >= first && !created_note {
                // Undoing a publication on a pre-existing note would require restoring an
                // earlier manifest, which a note rollback does not own.
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            Ok(false)
        }
        _ => Err(DomainError::validation(ValidationReason::InvalidState).into()),
    }
}

pub(super) async fn sync_entrypoint(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    note: &NoteId,
    ability: &AbilityId,
) -> Result<(), PortError> {
    // Match ordinary rename and trash/restore: only a lifecycle change advances updated_seq.
    let sql = "UPDATE ability_packages AS p SET slug_fold=h.slug_fold, lifecycle_state=h.lifecycle_state,
        updated_seq=CASE WHEN p.lifecycle_state <> h.lifecycle_state THEN h.updated_seq ELSE p.updated_seq END
        FROM note_heads AS h WHERE p.space_id=$1 AND p.ability_id=$2 AND p.entrypoint_note_id=$3
        AND h.space_id=p.space_id AND h.note_id=p.entrypoint_note_id AND h.ability_id=p.ability_id
        AND p.lifecycle_state<>'purged'";
    let count = match tx {
        BackendConn::Sqlite(conn) => sqlx::query(sql)
            .bind(space.as_str())
            .bind(ability.as_str())
            .bind(note.as_str())
            .execute(&mut **conn)
            .await
            .map(|r| r.rows_affected()),
        BackendConn::Postgres(conn) => sqlx::query(sql)
            .bind(space.as_str())
            .bind(ability.as_str())
            .bind(note.as_str())
            .execute(&mut **conn)
            .await
            .map(|r| r.rows_affected()),
    }
    .map_err(|err| internal_not_committed("rollback_sync_ability", err.to_string()))?;
    if count != 1 {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(())
}
