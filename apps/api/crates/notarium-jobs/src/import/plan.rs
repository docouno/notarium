use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use notarium_canonical::{
    CanonicalStore,
    peers::archive_import::{ImportParent, PlannedImportFolder, PlannedImportNote},
};
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, JobId, NoteId},
    model::HistoryScope,
    ports::CreateNote,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use super::{PLAN_VERSION, invalid, plan_error, sync_plan};
use crate::JobExecution;

const MAX_BATCH_NOTES: usize = 200;
const MAX_BATCH_BYTES: usize = 32 * 1024 * 1024;

struct Placement {
    ordinal: u64,
    path_key: String,
    slug: String,
    id: String,
    existing_folder: Option<FolderId>,
    parent: ImportParent,
    new_ancestors: bool,
    class: Option<DocClass>,
}

pub(crate) enum ImportBatch {
    Folder(PlannedImportFolder),
    Notes(Vec<PlannedImportNote>),
}

/// Resolve already-existing directories before sealing. A new ancestor can
/// have no preexisting descendants, so only existing paths require a read.
pub(crate) async fn bind_paths(
    store: &CanonicalStore,
    job: &JobExecution,
    path: PathBuf,
    root: FolderId,
) -> Result<u64, PortError> {
    let path = Arc::new(path);
    let mut ordinal = 1;
    loop {
        let ctx = job.authorize().await?;
        let page = job
            .blocking({
                let path = path.clone();
                move |_| {
                    let db = open_plan(&path, false)?;
                    let count: i64 = db
                        .query_row("SELECT count(*) FROM plan_order", [], |row| row.get(0))
                        .map_err(plan_error)?;
                    Ok(count as u64)
                }
            })
            .await?;
        while ordinal <= page {
            let placement = job
                .blocking({
                    let path = path.clone();
                    let root = root.clone();
                    move |_| {
                        let db = open_plan(&path, false)?;
                        placement(&db, &root, ordinal)?
                            .ok_or_else(|| invalid(ValidationReason::InvalidState))
                    }
                })
                .await?;
            let space_grant = &ctx.auth().spaces()[&ctx.scope().space_id];
            let class = placement.class.unwrap_or(DocClass::UserDoc);
            if !space_grant.write_classes.contains(&class) {
                return Err(DomainError::SpaceReadOnly.into());
            }
            if !placement.new_ancestors {
                let existing = store
                    .inspect_import_path(&ctx, &placement.parent, &placement.slug, placement.class)
                    .await?;
                if let Some(id) = existing {
                    job.blocking({
                        let path = path.clone();
                        let key = placement.path_key;
                        move |_| {
                            let db = open_plan(&path, true)?;
                            db.execute(
                                "UPDATE entries SET resolved_folder=?1 WHERE key=?2",
                                params![id.as_str(), key],
                            )
                            .map_err(plan_error)?;
                            Ok(())
                        }
                    })
                    .await?;
                }
            }
            ordinal += 1;
            if ordinal % MAX_BATCH_NOTES as u64 == 0 {
                tokio::task::yield_now().await;
                break;
            }
        }
        if ordinal > page {
            job.blocking({
                let path = path.clone();
                move |_| sync_plan(&path)
            })
            .await?;
            return Ok(page);
        }
    }
}

pub(crate) fn validate_plan(
    path: &Path,
    scope: &HistoryScope,
    job: &JobId,
    source_digest: ContentDigest,
    entries: u64,
) -> Result<(), PortError> {
    let db = open_plan(path, false)?;
    let identity: (String, Vec<u8>, String, Vec<u8>) = db
        .query_row(
            "SELECT space, history, job, source_digest FROM plan WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(plan_error)?;
    let units: i64 = db
        .query_row("SELECT count(*) FROM plan_order", [], |row| row.get(0))
        .map_err(plan_error)?;
    if identity.0 != scope.space_id.as_str()
        || identity.1 != scope.incarnation.as_bytes()
        || identity.2 != job.as_str()
        || identity.3 != source_digest.as_bytes()
        || units as u64 != entries
    {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(())
}

pub(crate) fn read_batch(
    path: &Path,
    root: &FolderId,
    ordinal: u64,
) -> Result<Option<ImportBatch>, PortError> {
    let db = open_plan(path, false)?;
    let mut notes = Vec::new();
    let mut remaining = MAX_BATCH_BYTES;
    for current in ordinal..ordinal + MAX_BATCH_NOTES as u64 {
        let Some(placement) = placement(&db, root, current)? else {
            break;
        };
        let Some(class) = placement.class else {
            if !notes.is_empty() {
                break;
            }
            let (id, reuse) = match placement.existing_folder {
                Some(id) => (id, true),
                None => (FolderId::parse(&placement.id)?, false),
            };
            return Ok(Some(ImportBatch::Folder(PlannedImportFolder {
                ordinal: placement.ordinal,
                parent: placement.parent,
                id,
                slug: placement.slug,
                reuse,
            })));
        };
        let len: i64 = db
            .query_row(
                "SELECT length(CAST(carrier AS BLOB)) FROM entries WHERE key=?1",
                [&placement.path_key],
                |row| row.get(0),
            )
            .map_err(plan_error)?;
        if len < 0 || len as usize > MAX_BATCH_BYTES {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        if len as usize > remaining {
            break;
        }
        remaining -= len as usize;
        let (carrier, digest): (String, Vec<u8>) = db
            .query_row(
                "SELECT carrier, final_digest FROM entries WHERE key=?1",
                [&placement.path_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(plan_error)?;
        if notarium_syntax::content_digest(&carrier)
            .as_bytes()
            .as_slice()
            != digest
        {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        let note = CreateNote {
            note: NoteId::parse(&placement.id)?,
            parent: Some(placement.parent.folder().clone()),
            slug: placement.slug,
            class,
            carrier,
        };
        notes.push(PlannedImportNote {
            ordinal: current,
            parent: placement.parent,
            note,
        });
    }
    Ok((!notes.is_empty()).then_some(ImportBatch::Notes(notes)))
}

fn open_plan(path: &Path, write: bool) -> Result<Connection, PortError> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags).map_err(plan_error)?;
    let version: u32 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(plan_error)?;
    if version != PLAN_VERSION {
        return Err(invalid(ValidationReason::UnsupportedContainer));
    }
    db.pragma_update(None, "cache_size", -4096i64)
        .map_err(plan_error)?;
    db.pragma_update(None, "trusted_schema", false)
        .map_err(plan_error)?;
    Ok(db)
}

fn placement(
    db: &Connection,
    root: &FolderId,
    ordinal: u64,
) -> Result<Option<Placement>, PortError> {
    let row = db
        .query_row(
            "SELECT e.key, e.parent, e.slug, e.id, e.resolved_folder, e.class
         FROM plan_order p JOIN entries e ON e.key=p.key WHERE p.ordinal=?1",
            [ordinal as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(plan_error)?;
    let Some((path_key, mut parent, slug, id, existing, class)) = row else {
        return Ok(None);
    };
    let mut ancestors = Vec::new();
    let mut new_ancestors = false;
    let mut query = db
        .prepare(
            "SELECT parent, slug, id, resolved_folder FROM entries WHERE key=?1 AND class IS NULL",
        )
        .map_err(plan_error)?;
    while !parent.is_empty() {
        if ancestors.len() == 64 {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
        let (prefix, part, id, reused) = query
            .query_row([parent], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(plan_error)?;
        new_ancestors |= reused.is_none();
        let id = FolderId::parse(reused.as_deref().unwrap_or(&id))?;
        ancestors.push((part, id));
        parent = prefix;
    }
    ancestors.reverse();
    let class = class
        .as_deref()
        .map(notarium_canonical::codec::doc_class_from_db)
        .transpose()?;
    Ok(Some(Placement {
        ordinal,
        path_key,
        slug,
        id,
        parent: ImportParent {
            root: root.clone(),
            ancestors,
        },
        existing_folder: existing.as_deref().map(FolderId::parse).transpose()?,
        new_ancestors,
        class,
    }))
}
