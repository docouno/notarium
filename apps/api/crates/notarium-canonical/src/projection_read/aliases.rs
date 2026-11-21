use notarium_core::{
    error::PortError,
    ids::{FolderId, NoteId, SpaceSeq},
    model::HistoryScope,
    ports::{MaintenanceContext, PageLimit},
};

use crate::{
    CanonicalStore,
    codec::{i64_to_space_seq, internal_not_committed},
    runtime::pg_read_error,
    sql_exec::BackendConn,
};

use super::{ProjectionPage, checked_cut, page_next, truncate_page};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionNoteAlias {
    pub old_parent_folder_id: FolderId,
    pub old_slug_fold: String,
    pub old_title_norm: String,
    pub created_seq: SpaceSeq,
    pub target_note_id: NoteId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionFolderAlias {
    pub old_parent_folder_id: FolderId,
    pub old_slug_fold: String,
    pub created_seq: SpaceSeq,
    pub target_folder_id: FolderId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionAlias {
    Note(ProjectionNoteAlias),
    Folder(ProjectionFolderAlias),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionAliasCursor {
    Note(ProjectionNoteAlias),
    FirstFolder,
    Folder(ProjectionFolderAlias),
}

type NoteRow = (String, String, String, i64, String);
type FolderRow = (String, String, i64, String);

macro_rules! note_alias_query {
    () => {
        "SELECT a.old_parent_folder_id, a.old_slug_fold, a.old_title_norm, a.created_seq, a.target_note_id
         FROM note_aliases a
         WHERE a.space_id = $1 AND a.created_seq <= $2 AND NOT EXISTS (
             SELECT 1 FROM revision_purge_fences p
             WHERE p.space_id = a.space_id AND p.note_id = a.target_note_id
         ) AND "
    };
}

impl CanonicalStore {
    /// Lists historical path aliases and rename titles at a fixed Space cut.
    pub async fn read_projection_aliases_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        after: Option<ProjectionAliasCursor>,
        limit: PageLimit,
    ) -> Result<ProjectionPage<ProjectionAlias, ProjectionAliasCursor>, PortError> {
        let scope = scope.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                checked_cut(tx, &scope, cutoff).await?;
                match after.as_ref() {
                    None => note_page(tx, &scope, cutoff, None, limit).await,
                    Some(ProjectionAliasCursor::Note(key)) => {
                        note_page(tx, &scope, cutoff, Some(key), limit).await
                    }
                    Some(ProjectionAliasCursor::FirstFolder) => {
                        folder_page(tx, &scope, cutoff, None, limit).await
                    }
                    Some(ProjectionAliasCursor::Folder(key)) => {
                        folder_page(tx, &scope, cutoff, Some(key), limit).await
                    }
                }
            })
        })
        .await
    }
}

async fn note_page(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    after: Option<&ProjectionNoteAlias>,
    limit: PageLimit,
) -> Result<ProjectionPage<ProjectionAlias, ProjectionAliasCursor>, PortError> {
    const QUERY: &str = concat!(
        note_alias_query!(),
        " (a.old_parent_folder_id, a.old_slug_fold, a.created_seq, a.target_note_id) > ($3, $4, $5, $6)
          ORDER BY a.old_parent_folder_id, a.old_slug_fold, a.created_seq, a.target_note_id LIMIT $7"
    );
    let after = after.map_or(("", "", 0, ""), |key| {
        (
            key.old_parent_folder_id.as_str(),
            key.old_slug_fold.as_str(),
            key.created_seq.get() as i64,
            key.target_note_id.as_str(),
        )
    });
    let mut batch = read_rows!(
        tx,
        fetch_all,
        "projection_note_aliases",
        NoteRow,
        QUERY,
        scope.space_id.as_str(),
        cutoff.get() as i64,
        after.0,
        after.1,
        after.2,
        after.3,
        i64::from(limit.get()) + 1,
    )?;
    let more = truncate_page(&mut batch, limit);
    let rows = batch
        .into_iter()
        .map(note_row)
        .collect::<Result<Vec<_>, _>>()?;
    let next = if more {
        page_next(&rows, true, |row| ProjectionAliasCursor::Note(row.clone()))
    } else if rows.is_empty() {
        return folder_page(tx, scope, cutoff, None, limit).await;
    } else {
        Some(ProjectionAliasCursor::FirstFolder)
    };
    Ok(ProjectionPage {
        rows: rows.into_iter().map(ProjectionAlias::Note).collect(),
        next,
    })
}

async fn folder_page(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    after: Option<&ProjectionFolderAlias>,
    limit: PageLimit,
) -> Result<ProjectionPage<ProjectionAlias, ProjectionAliasCursor>, PortError> {
    const QUERY: &str =
        "SELECT a.old_parent_folder_id, a.old_slug_fold, a.created_seq, a.target_folder_id
         FROM folder_aliases a WHERE a.space_id = $1 AND a.created_seq <= $2
           AND (a.old_parent_folder_id, a.old_slug_fold, a.created_seq, a.target_folder_id) > ($3, $4, $5, $6)
         ORDER BY a.old_parent_folder_id, a.old_slug_fold, a.created_seq, a.target_folder_id LIMIT $7";
    let after = after.map_or(("", "", 0, ""), |key| {
        (
            key.old_parent_folder_id.as_str(),
            key.old_slug_fold.as_str(),
            key.created_seq.get() as i64,
            key.target_folder_id.as_str(),
        )
    });
    let mut batch = read_rows!(
        tx,
        fetch_all,
        "projection_folder_aliases",
        FolderRow,
        QUERY,
        scope.space_id.as_str(),
        cutoff.get() as i64,
        after.0,
        after.1,
        after.2,
        after.3,
        i64::from(limit.get()) + 1,
    )?;
    let more = truncate_page(&mut batch, limit);
    let rows = batch
        .into_iter()
        .map(folder_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ProjectionPage {
        next: page_next(&rows, more, |row| {
            ProjectionAliasCursor::Folder(row.clone())
        }),
        rows: rows.into_iter().map(ProjectionAlias::Folder).collect(),
    })
}

pub(super) async fn aliases_in_range(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    after: SpaceSeq,
    end: SpaceSeq,
) -> Result<Vec<ProjectionAlias>, PortError> {
    const NOTES: &str = concat!(
        note_alias_query!(),
        " a.created_seq > $3 ORDER BY a.created_seq"
    );
    const FOLDERS: &str =
        "SELECT a.old_parent_folder_id, a.old_slug_fold, a.created_seq, a.target_folder_id
         FROM folder_aliases a WHERE a.space_id = $1 AND a.created_seq <= $2
           AND a.created_seq > $3 ORDER BY a.created_seq";
    let notes = read_rows!(
        tx,
        fetch_all,
        "projection_note_aliases_delta",
        NoteRow,
        NOTES,
        scope.space_id.as_str(),
        end.get() as i64,
        after.get() as i64,
    )?;
    let folders = read_rows!(
        tx,
        fetch_all,
        "projection_folder_aliases_delta",
        FolderRow,
        FOLDERS,
        scope.space_id.as_str(),
        end.get() as i64,
        after.get() as i64,
    )?;
    notes
        .into_iter()
        .map(|row| Ok(ProjectionAlias::Note(note_row(row)?)))
        .chain(
            folders
                .into_iter()
                .map(|row| Ok(ProjectionAlias::Folder(folder_row(row)?))),
        )
        .collect()
}

fn note_row((parent, slug, title, seq, target): NoteRow) -> Result<ProjectionNoteAlias, PortError> {
    Ok(ProjectionNoteAlias {
        old_parent_folder_id: FolderId::parse(&parent)?,
        old_slug_fold: slug,
        old_title_norm: title,
        created_seq: i64_to_space_seq(seq)?,
        target_note_id: NoteId::parse(&target)?,
    })
}

fn folder_row((parent, slug, seq, target): FolderRow) -> Result<ProjectionFolderAlias, PortError> {
    Ok(ProjectionFolderAlias {
        old_parent_folder_id: FolderId::parse(&parent)?,
        old_slug_fold: slug,
        created_seq: i64_to_space_seq(seq)?,
        target_folder_id: FolderId::parse(&target)?,
    })
}
