//! As-of pages for a whole-Space export that exceeds the compact read cut.
//! Updates preserve only the first pre-image per cut. Removing the scoped CAS
//! hold also removes its cut and retained rows.

use std::collections::HashMap;

use notarium_core::ids::LeaseEpoch;
use serde::de::DeserializeOwned;
use sqlx::AssertSqlSafe;

use super::*;
use crate::{blobs::lock_and_check_space_tx, schema::archive_versions::VERSIONED};

const PAGE: i64 = 256;
const PAGE_BUDGET: Duration = Duration::from_millis(45);

#[derive(Clone)]
struct VersionedCut {
    hold: BackupId,
    scope: HistoryScope,
    seq: SpaceSeq,
    generation: u64,
    root: FolderId,
}

pub(super) async fn capture(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    claim: &ClaimedContentJob,
    hold: BackupId,
    encrypted: bool,
    after_registration: impl std::future::Future<Output = Result<(), PortError>>,
) -> Result<(SpaceSeq, u64, Vec<ExportEntry>, Duration), PortError> {
    let mut budget = ctx.budget.clone();
    budget.remaining = budget.remaining.min(PAGE_BUDGET);
    let scope = ctx.scope().clone();
    let epoch = store
        .read_space_fast_or_pool(&scope.space_id, Some(&budget))
        .await?
        .active_epoch;
    store.inner.check_writer_epoch(&scope.space_id, epoch)?;
    let deadline = CommandDeadline::start(&budget, "register_versioned_export");
    let auth = ctx.auth().clone();
    let claimant = claim.clone();
    let started = Instant::now();
    let (cut, space) = store
        .with_auxiliary_command(Some((&budget, deadline)), Ok, move |tx| {
            Box::pin(async move { register(tx, scope, epoch, &auth, &claimant, hold).await })
        })
        .await?;
    let elapsed = started.elapsed();
    if elapsed >= CUT_LIMIT {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    after_registration.await?;
    let budget = &ctx.budget;
    let folders = read_folders(store, budget, &cut).await?;
    let schemas = pages(store, budget, &cut, "schema").await?;
    let current_schema = current_schema(schemas)?;
    let mut files = read_notes(store, budget, &cut, &folders, current_schema, encrypted).await?;
    read_packages(store, budget, &cut, &mut files).await?;
    read_chats(store, budget, &cut, &space, ctx.auth(), &mut files).await?;
    Ok((cut.seq, cut.generation, files, elapsed))
}

async fn register(
    tx: &mut BackendConn<'_>,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    auth: &notarium_core::auth::EngineAuthContext,
    claim: &ClaimedContentJob,
    hold: BackupId,
) -> Result<(VersionedCut, crate::SpaceRecord), PortError> {
    let space = lock_and_check_space_tx(tx, &scope, epoch).await?;
    authorize_job_write_for_export(auth, &space)?;
    authorize_full_space_export(auth, &space.space)?;
    let (job, _, erased) = require_active_job_lease_tx(
        tx,
        &scope,
        &claim.job.id,
        &claim.lease_owner,
        claim.job.lease,
    )
    .await?;
    if erased || !matches!(job.kind, ContentJobKind::ExportSpace { .. }) {
        return Err(DomainError::ResourceNotFound.into());
    }
    let generation = privacy_generation_tx(tx, &scope.space_id).await?;
    const INSERT: &str =
        "INSERT INTO archive_export_cuts(backup_id,space_id,cutoff_seq) VALUES($1,$2,$3)";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(INSERT)
            .bind(hold.as_str())
            .bind(scope.space_id.as_str())
            .bind(space.last_seq.get() as i64)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(INSERT)
            .bind(hold.as_str())
            .bind(scope.space_id.as_str())
            .bind(space.last_seq.get() as i64)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(sql_error)?;
    Ok((
        VersionedCut {
            hold,
            scope,
            seq: space.last_seq,
            generation,
            root: space.root_folder_id.clone(),
        },
        space,
    ))
}

async fn check_cut(tx: &mut BackendConn<'_>, cut: &VersionedCut) -> Result<(), PortError> {
    const EXISTS: &str = "SELECT EXISTS(
        SELECT 1 FROM archive_export_cuts c JOIN backup_holds h
           ON h.space_id=c.space_id AND h.backup_id=c.backup_id
        JOIN spaces s ON s.space_id=c.space_id AND s.history_incarnation=h.history_incarnation
        LEFT JOIN archive_privacy p ON p.space_id=c.space_id
        WHERE c.backup_id=$1 AND c.space_id=$2 AND c.cutoff_seq=$3 AND COALESCE(p.generation,0)=$4
        AND s.history_incarnation=$5 AND s.lifecycle_state='active')";
    macro_rules! query {
        ($conn:expr) => {
            sqlx::query_scalar(EXISTS)
                .bind(cut.hold.as_str())
                .bind(cut.scope.space_id.as_str())
                .bind(cut.seq.get() as i64)
                .bind(cut.generation as i64)
                .bind(cut.scope.incarnation.as_bytes().as_slice())
                .fetch_one(&mut **$conn)
                .await
        };
    }
    let current: bool = match tx {
        BackendConn::Sqlite(conn) => query!(conn),
        BackendConn::Postgres(conn) => query!(conn),
    }
    .map_err(sql_error)?;
    if current {
        Ok(())
    } else {
        Err(DomainError::ResourceNotFound.into())
    }
}

async fn pages<T: DeserializeOwned>(
    store: &CanonicalStore,
    budget: &CallBudget,
    cut: &VersionedCut,
    kind: &str,
) -> Result<Vec<(String, T)>, PortError> {
    let spec = VERSIONED
        .iter()
        .find(|spec| spec.kind == kind)
        .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
    let mut budget = budget.clone();
    budget.remaining = budget.remaining.min(PAGE_BUDGET);
    let mut result = Vec::new();
    let mut after = String::new();
    loop {
        let from = after.clone();
        let cut = cut.clone();
        let rows: Vec<(String, String)> = store.with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                check_cut(tx, &cut).await?;
                let pg = tx.is_postgres();
                let collation = if pg { " COLLATE \"C\"" } else { "" };
                // Independently limit the live and shadow inputs. Their keys
                // are disjoint, so the next page needs at most PAGE from each.
                let select = format!(
                    "SELECT id,payload FROM (
                       SELECT * FROM (SELECT live.{key} AS id,{payload} AS payload FROM {table} live
                       WHERE live.space_id=$1 AND live.created_seq<=$2 AND live.{key}{collation}>$4
                       AND NOT EXISTS(SELECT 1 FROM archive_export_shadows old WHERE
                           old.backup_id=$3 AND old.space_id=$1 AND old.entity_kind='{kind}' AND old.entity_id=live.{key})
                       ORDER BY live.{key}{collation} LIMIT {PAGE}) a
                       UNION ALL
                       SELECT * FROM (SELECT entity_id,payload FROM archive_export_shadows
                       WHERE space_id=$1 AND backup_id=$3 AND entity_kind='{kind}' AND entity_id{collation}>$4
                       ORDER BY entity_id{collation} LIMIT {PAGE}) b
                    ) all_rows ORDER BY id{collation} LIMIT {PAGE}",
                    key=spec.key, table=spec.table, kind=spec.kind, payload=spec.payload("live", pg),
                );
                macro_rules! read {
                    ($conn:expr) => { sqlx::query_as(AssertSqlSafe(select)).bind(cut.scope.space_id.as_str())
                        .bind(cut.seq.get() as i64).bind(cut.hold.as_str()).bind(from)
                        .fetch_all(&mut **$conn).await };
                }
                match tx { BackendConn::Sqlite(conn) => read!(conn), BackendConn::Postgres(conn) => read!(conn) }.map_err(sql_error)
            })
        }).await?;
        if rows.is_empty() {
            return Ok(result);
        }
        if result.len() + rows.len() > MAX_EXPORT_ITEMS as usize {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let more = rows.len() == PAGE as usize;
        after.clone_from(&rows.last().expect("nonempty page").0);
        for (id, row) in rows {
            let value =
                serde_json::from_str(&row).map_err(|_| invalid(ValidationReason::InvalidState))?;
            result.push((id, value));
        }
        if !more {
            return Ok(result);
        }
    }
}

type FolderRow = (Option<String>, i64, String, String);

async fn read_folders(
    store: &CanonicalStore,
    budget: &CallBudget,
    cut: &VersionedCut,
) -> Result<HashMap<String, FolderRow>, PortError> {
    Ok(pages(store, budget, cut, "folder")
        .await?
        .into_iter()
        .collect())
}

fn folder_path(
    folders: &HashMap<String, FolderRow>,
    folder: &str,
    root: &FolderId,
) -> Result<Option<String>, PortError> {
    let mut names = Vec::new();
    let mut next = folder;
    for _ in 0..256 {
        let (parent, is_root, slug, lifecycle) = folders
            .get(next)
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        if lifecycle != "active" {
            return Ok(None);
        }
        match parent {
            None if *is_root == 1 && next == root.as_str() => {
                names.reverse();
                let mut path = names.join("/");
                if !path.is_empty() {
                    path.push('/');
                }
                return Ok(Some(path));
            }
            Some(parent) if *is_root == 0 => {
                names.push(slug.as_str());
                next = parent;
            }
            _ => break,
        }
    }
    Err(invalid(ValidationReason::InvalidArchive))
}

fn current_schema(rows: Vec<(String, (String, i64))>) -> Result<Option<String>, PortError> {
    let mut current = None;
    for (_, (note, active)) in rows {
        if active == 1 && current.replace(note).is_some() {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    Ok(current)
}

type NoteRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

async fn read_notes(
    store: &CanonicalStore,
    budget: &CallBudget,
    cut: &VersionedCut,
    folders: &HashMap<String, FolderRow>,
    schema: Option<String>,
    encrypted: bool,
) -> Result<Vec<ExportEntry>, PortError> {
    let notes = pages::<NoteRow>(store, budget, cut, "note").await?;
    let mut result = Vec::new();
    let mut cached_paths = HashMap::new();
    for (id, (folder, name, class, ability, hash, lifecycle)) in notes {
        if lifecycle != "active" || ability.is_some() {
            continue;
        }
        let path = match cached_paths.entry(folder) {
            std::collections::hash_map::Entry::Occupied(path) => path.into_mut(),
            std::collections::hash_map::Entry::Vacant(path) => {
                let resolved = folder_path(folders, path.key(), &cut.root)?;
                path.insert(resolved)
            }
        };
        let Some(path) = path else {
            continue;
        };
        if doc_class_from_db(&class)? == DocClass::EncryptedNote && !encrypted {
            return Err(invalid(ValidationReason::ClassEgressForbidden));
        }
        let path = if schema.as_ref() == Some(&id) {
            ".notarium/fields/schema.yaml".into()
        } else {
            format!("{path}{name}.md")
        };
        let hash = hex::decode(hash.ok_or_else(|| invalid(ValidationReason::InvalidDigest))?)
            .map_err(|_| invalid(ValidationReason::InvalidDigest))?;
        result.push(ExportEntry {
            path,
            data: ExportData::Blob(digest(hash)?),
        });
    }
    Ok(result)
}

async fn read_packages(
    store: &CanonicalStore,
    budget: &CallBudget,
    cut: &VersionedCut,
    files: &mut Vec<ExportEntry>,
) -> Result<(), PortError> {
    type PackageRow = (String, String, String);
    let packages = pages::<PackageRow>(store, budget, cut, "package").await?;
    let mut budget = budget.clone();
    budget.remaining = budget.remaining.min(PAGE_BUDGET);
    for (id, (slug, revision, lifecycle)) in packages {
        if lifecycle != "active" {
            continue;
        }
        let cut = cut.clone();
        let resources: Vec<(String, Vec<u8>)> = store
            .with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    check_cut(tx, &cut).await?;
                    const SQL: &str =
                        "SELECT resource_key,content_blake3 FROM blob_references WHERE space_id=$1
                   AND owner_kind='ability_resource' AND owner_id=$2 AND owner_rev_id=$3 LIMIT 258";
                    macro_rules! read {
                        ($conn:expr) => {
                            sqlx::query_as(SQL)
                                .bind(cut.scope.space_id.as_str())
                                .bind(id)
                                .bind(revision)
                                .fetch_all(&mut **$conn)
                                .await
                        };
                    }
                    match tx {
                        BackendConn::Sqlite(conn) => read!(conn),
                        BackendConn::Postgres(conn) => read!(conn),
                    }
                    .map_err(sql_error)
                })
            })
            .await?;
        if resources.is_empty()
            || resources.len() > 257
            || files.len() + resources.len() > MAX_EXPORT_ITEMS as usize
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        for (name, hash) in resources {
            files.push(ExportEntry {
                path: format!(".notarium/abilities/{slug}/{name}"),
                data: ExportData::Blob(digest(hash)?),
            });
        }
    }
    Ok(())
}

async fn read_chats(
    store: &CanonicalStore,
    budget: &CallBudget,
    cut: &VersionedCut,
    space: &crate::SpaceRecord,
    auth: &notarium_core::auth::EngineAuthContext,
    files: &mut Vec<ExportEntry>,
) -> Result<(), PortError> {
    type Head = (String, String, String, Option<String>, i64, i64);
    let heads = pages::<Head>(store, budget, cut, "thread")
        .await?
        .into_iter()
        .map(|(id, (owner, kind, title, project, taint, head))| {
            (id, owner, kind, title, project, taint, head)
        })
        .collect();
    let chats = index_chat_headers(space, auth, MAX_EXPORT_ITEMS - files.len() as i64, heads)?;
    files.extend(chats.into_iter().map(|(thread, chat)| ExportEntry {
        path: format!("chats/{thread}.jsonl"),
        data: ExportData::PagedChat(
            chat.header,
            VersionedChatEntries {
                cut: cut.clone(),
                thread,
            },
        ),
    }));
    Ok(())
}

/// Reads one thread at a published export cut. The provider retains no SQL
/// transaction while the consumer writes or compresses the returned page.
pub struct VersionedChatEntries {
    cut: VersionedCut,
    thread: String,
}

impl VersionedChatEntries {
    pub async fn page(
        &self,
        store: &CanonicalStore,
        budget: &CallBudget,
        after: u64,
    ) -> Result<Vec<ExportChatEntry>, PortError> {
        let after = i64::try_from(after).map_err(|_| invalid(ValidationReason::InvalidRange))?;
        let mut budget = budget.clone();
        budget.remaining = budget.remaining.min(PAGE_BUDGET);
        let cut = self.cut.clone();
        let thread = self.thread.clone();
        store.with_read_tx_budget(Some(&budget), move |tx| {
        Box::pin(async move {
            check_cut(tx, &cut).await?;
            const SQL: &str = "SELECT e.thread_id,e.entry_seq,e.parent_seq,e.kind,e.author_id,e.inline_text,
                e.payload_blake3,r.created_at_sec,CAST(COALESCE(r.created_at_nsec,-1) AS BIGINT),CAST(e.checkpoint_stale AS BIGINT)
                FROM chat_entries e LEFT JOIN change_log l ON l.space_id=e.space_id AND l.space_seq=e.created_space_seq
        AND l.entity_type='thread' AND l.entity_id=e.thread_id
    LEFT JOIN revisions r ON r.space_id=e.space_id AND r.rev_id=l.rev_id
                WHERE e.space_id=$1 AND e.thread_id=$2 AND e.entry_seq>$3 AND e.created_space_seq<=$4
                ORDER BY e.thread_id,e.entry_seq LIMIT $5";
            macro_rules! read {
                ($conn:expr) => { sqlx::query_as::<_, (String,i64,Option<i64>,String,String,Option<String>,Option<Vec<u8>>,i64,i64,i64)>(SQL)
                    .bind(cut.scope.space_id.as_str()).bind(thread).bind(after).bind(cut.seq.get() as i64)
                    .bind(PAGE).fetch_all(&mut **$conn).await };
            }
            let rows = match tx { BackendConn::Sqlite(conn) => read!(conn), BackendConn::Postgres(conn) => read!(conn) }.map_err(sql_error)?;
            rows.into_iter().map(|(thread,seq,parent,kind,author,inline,reference,seconds,nanos,stale)|
                chat_entry(ChatRow { thread,seq,parent,kind,author,inline,reference,seconds,nanos,stale })).collect()
        })
    }).await
    }
}
