use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{AgentRunId, FolderId, NoteId, PrincipalId, SpaceSeq},
    model::HistoryScope,
    ports::CreateNote,
    value::Timestamp,
};

use crate::{
    codec::{
        FolderRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload,
        encode_timestamp_parts, internal_not_committed, new_revision_id, normalize_slug_key,
    },
    runtime::{insert_revision_row, load_folder_head_row},
    sql_exec::BackendConn,
};

pub(crate) const SLUG: &str = "index";

pub(super) fn validate_create(input: &CreateNote) -> Result<String, PortError> {
    let folded = normalize_slug_key(&input.slug)?;
    if input.folder_page && input.slug != SLUG || !input.folder_page && folded == SLUG {
        return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
    }
    Ok(folded)
}

pub(super) fn validate_slug_change(
    before: &str,
    after: &str,
    raw_after: &str,
    is_cover: bool,
) -> Result<(), PortError> {
    if (is_cover && raw_after != SLUG) || (after == SLUG && before != SLUG) {
        return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
    }
    Ok(())
}

/// The covering note and the induced folder revision share the note mutation's
/// visibility boundary. The note event and its effect still own that boundary.
#[allow(clippy::too_many_arguments)]
pub(super) async fn assign(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    folder: &FolderId,
    cover: Option<&NoteId>,
    seq: SpaceSeq,
    visibility: SpaceSeq,
    actor: &PrincipalId,
    run: Option<&AgentRunId>,
    now: Timestamp,
) -> Result<(), PortError> {
    let row = load_folder_head_row(tx, &scope.space_id, folder).await?;
    if row.cover_note_id.as_ref() == cover {
        return Ok(());
    }

    let revision = new_revision_id()?;
    let (seconds, nanos) = encode_timestamp_parts(now);
    let update = "UPDATE folder_heads SET cover_note_id=$1, head_rev_id=$2,
                  rev_seq=$3, updated_seq=$4, updated_at_sec=$5, updated_at_nsec=$6
                  WHERE space_id=$7 AND folder_id=$8";
    macro_rules! update {
        ($conn:expr) => {
            sqlx::query(update)
                .bind(cover.map(NoteId::as_str))
                .bind(revision.as_str())
                .bind(seq.get() as i64)
                .bind(visibility.get() as i64)
                .bind(seconds)
                .bind(nanos)
                .bind(scope.space_id.as_str())
                .bind(folder.as_str())
                .execute($conn)
                .await
                .map(|result| result.rows_affected())
        };
    }
    let updated = match tx {
        BackendConn::Sqlite(conn) => update!(&mut **conn),
        BackendConn::Postgres(conn) => update!(&mut **conn),
    }
    .map_err(|err| internal_not_committed("update_folder_cover", err.to_string()))?;
    if updated != 1 {
        return Err(internal_not_committed(
            "update_folder_cover",
            "folder disappeared during write",
        ));
    }
    let payload =
        RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(FolderRevisionMetadata {
            confirmation: None,
            folder_id: folder.clone(),
            parent_folder_id: row.parent_folder_id,
            is_root: row.is_root,
            slug: row.slug,
            slug_fold: row.slug_fold,
            display_name: row.display_name,
            is_project: row.is_project,
            project_slug: row.project_slug,
            description: row.description,
            cover_note_id: cover.cloned(),
            write_locked: row.write_locked,
            lifecycle: row.lifecycle,
        }))
        .encode()?;
    insert_revision_row(
        tx,
        scope,
        &revision,
        "folder",
        folder.as_str(),
        seq,
        visibility,
        Some(&row.head_rev_id),
        None,
        None,
        &payload,
        actor,
        run,
        now,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn clear_purged(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    seq: SpaceSeq,
    visibility: SpaceSeq,
    actor: &PrincipalId,
    run: Option<&AgentRunId>,
    now: Timestamp,
) -> Result<(), PortError> {
    let select = "SELECT folder_id FROM folder_heads WHERE space_id=$1 AND cover_note_id=$2 ORDER BY folder_id";
    let folders: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(select)
                .bind(scope.space_id.as_str())
                .bind(note.as_str())
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(select)
                .bind(scope.space_id.as_str())
                .bind(note.as_str())
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|err| internal_not_committed("find_purged_folder_cover", err.to_string()))?;
    for folder in folders {
        assign(
            tx,
            scope,
            &FolderId::parse(&folder)?,
            None,
            seq,
            visibility,
            actor,
            run,
            now,
        )
        .await?;
    }
    Ok(())
}
