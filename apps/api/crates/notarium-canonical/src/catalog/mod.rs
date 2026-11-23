//! Canonical-owned metadata consumed by the account and control services.
const LIST_PROJECTS: &str = "SELECT folder_id, created_seq
    FROM folder_heads
    WHERE space_id=$1 AND folder_id>$2 AND lifecycle_state='active' AND is_project=1
    AND ($3='' OR folder_id=$3)
    ORDER BY folder_id
    LIMIT $4";

use crate::{
    CanonicalStore, SpaceRecord,
    codec::{internal_not_committed, normalize_slug_key},
    domain::common::{build_resource_facts_tx, load_note_head_row_tx},
    runtime::{load_folder_head_row, load_space_record},
    sql_exec::BackendConn,
};
use notarium_core::{
    DomainError,
    auth::*,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::*,
    model::*,
    ports::*,
    receipt::AccountCommandIdentity,
};
use serde::{Deserialize, Serialize};

macro_rules! db {
    (read $($args:tt)*) => {
        db!($($args)*).map_err(|err| crate::runtime::pg_read_error("canonical_catalog_query", err))
    };
    (write $($args:tt)*) => {
        db!($($args)*).map_err(|err| internal_not_committed("canonical_catalog_query", err.to_string()))
    };
    ($tx:expr, $expr:expr, $method:ident $(,$arg:expr)* $(,)?) => {{
        match $tx {
            BackendConn::Sqlite(conn) => $expr$(.bind($arg))*.$method(&mut **conn).await,
            BackendConn::Postgres(conn) => $expr$(.bind($arg))*.$method(&mut **conn).await,
        }
    }}
}
mod abilities;
pub(crate) use abilities::{
    ability_manifest_tx, authorize_change_tx as authorize_ability_change_tx, resource_digest_tx,
};
mod commands;
pub(crate) mod egress;
pub(crate) mod memory;

fn catalog_space(record: SpaceRecord) -> CatalogSpace {
    CatalogSpace {
        space: record.space,
        slug: record.slug,
        history: record.scope,
        last_seq: record.last_seq,
    }
}

async fn folder_metadata(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: FolderRef,
) -> Result<(CatalogFolder, crate::runtime::FolderHeadRow), PortError> {
    let mut ancestry = crate::domain::common::FolderAncestryCache::default();
    folder_metadata_cached(tx, auth, space, reference, &mut ancestry).await
}

async fn folder_metadata_cached(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: FolderRef,
    ancestry_cache: &mut crate::domain::common::FolderAncestryCache,
) -> Result<(CatalogFolder, crate::runtime::FolderHeadRow), PortError> {
    if !auth.spaces().contains_key(&reference.space_id) || reference.space_id != space.space.id {
        return Err(DomainError::ResourceNotFound.into());
    }
    let row = load_folder_head_row(tx, &reference.space_id, &reference.folder_id).await?;
    ancestry_cache.insert_preloaded_row(space.space.id.clone(), row.clone());
    let ancestry = ancestry_cache
        .load_ancestry_tx(tx, &reference.space_id, &reference.folder_id, true)
        .await?;
    auth.can_view_folder(&space.space, &reference.folder_id, &ancestry.ancestors)?;
    Ok((
        CatalogFolder {
            reference,
            space: space.space.clone(),
            lifecycle: row.lifecycle,
            ancestor_folders: ancestry.ancestors,
            write_locked: ancestry.write_locked,
        },
        row,
    ))
}

fn project_info(
    folder: CatalogFolder,
    row: crate::runtime::FolderHeadRow,
) -> Result<ProjectInfo, PortError> {
    if !row.is_project {
        return Err(DomainError::ResourceNotFound.into());
    }
    let project_slug = row
        .project_slug
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
    Ok(ProjectInfo {
        folder: folder.reference,
        name: row.display_name,
        project_slug,
    })
}

async fn note_metadata(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: NoteRef,
) -> Result<CatalogNote, PortError> {
    let mut ancestry = crate::domain::common::FolderAncestryCache::default();
    note_metadata_with_digest(tx, auth, space, reference, &mut ancestry)
        .await
        .map(|(note, _)| note)
}

async fn note_metadata_with_digest(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: NoteRef,
    ancestry: &mut crate::domain::common::FolderAncestryCache,
) -> Result<(CatalogNote, Option<ContentDigest>), PortError> {
    if !auth.spaces().contains_key(&reference.space_id) || reference.space_id != space.space.id {
        return Err(DomainError::ResourceNotFound.into());
    }
    if crate::runtime::is_note_purge_fenced_tx(tx, &reference.space_id, reference.note_id.as_str())
        .await?
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let row = load_note_head_row_tx(tx, &reference.space_id, &reference.note_id).await?;
    if row.lifecycle != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let (facts, _) = ancestry
        .build_resource_facts_tx(
            tx,
            &space.space,
            &row.parent_folder_id,
            row.doc_class,
            row.ability_id,
            true,
        )
        .await?;
    auth.can_view_resource(&facts)?;
    Ok((
        CatalogNote {
            reference,
            lifecycle: row.lifecycle,
            facts,
        },
        row.content_digest,
    ))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor<K> {
    scope: String,
    after: K,
}

fn continuation<K: serde::de::DeserializeOwned>(
    page: &ControlPageRequest,
    scope: &str,
) -> Result<Option<K>, PortError> {
    page.continuation()
        .map(|raw| {
            let stale = || DomainError::validation(ValidationReason::CursorStale);
            if raw.len() > 2048 {
                return Err(stale().into());
            }
            let value: Cursor<K> = serde_json::from_str(raw).map_err(|_| stale())?;
            if value.scope != scope {
                return Err(stale().into());
            }
            Ok(value.after)
        })
        .transpose()
}
fn encode_cursor<K: Serialize>(scope: String, after: K) -> Result<String, PortError> {
    serde_json::to_string(&Cursor { scope, after })
        .map_err(|e| internal_not_committed("catalog_cursor", e.to_string()))
}
// A catalog candidate can still be filtered by the consumer. Its creation
// event is a stable, indexed cursor position without exposing the entity ID.
async fn cursor_entity(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    kind: &str,
    seq: i64,
) -> Result<String, PortError> {
    db!(
        read tx,
        sqlx::query_scalar("SELECT entity_id FROM change_log WHERE space_id=$1 AND space_seq=$2 AND entity_type=$3 AND op_kind='create'"),
        fetch_optional,
        space.as_str(),
        seq,
        kind
    )?.ok_or_else(|| DomainError::validation(ValidationReason::CursorStale).into())
}
fn digest(value: impl Serialize) -> Result<String, PortError> {
    let bytes = crate::codec::encode_msgpack(&value)?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

impl ControlCatalogPort for CanonicalStore {
    fn disclosure(
        &self,
        ctx: AccountContext,
        source: CatalogDisclosure,
    ) -> PortFuture<'_, notarium_core::classes::CanonicalMetadataContent> {
        Box::pin(egress::metadata(self, ctx, source))
    }
    fn folder_disclosures(
        &self,
        ctx: AccountContext,
        folders: Vec<FolderRef>,
    ) -> PortFuture<'_, Vec<notarium_core::classes::CanonicalMetadataContent>> {
        Box::pin(egress::folder_disclosures(self, ctx, folders))
    }
    fn existing_projects(
        &self,
        ctx: AccountContext,
        projects: Vec<FolderRef>,
    ) -> PortFuture<'_, Vec<FolderRef>> {
        Box::pin(async move {
            if projects.is_empty() {
                return Ok(Vec::new());
            }
            let budget = ctx.budget.clone();
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let mut spaces =
                        std::collections::BTreeMap::<SpaceId, Option<SpaceRecord>>::new();
                    let mut ancestry = crate::domain::common::FolderAncestryCache::default();
                    let mut out = Vec::with_capacity(projects.len());
                    for reference in projects {
                        if ctx
                            .auth()
                            .spaces()
                            .get(&reference.space_id)
                            .is_none_or(|grant| grant.read_classes.is_empty())
                        {
                            continue;
                        }
                        let space = if let Some(cached) = spaces.get(&reference.space_id) {
                            let Some(record) = cached else {
                                continue;
                            };
                            record
                        } else {
                            match load_space_record(tx, &reference.space_id).await {
                                Ok(record) if record.space.lifecycle == SpaceLifecycle::Active => {
                                    spaces.insert(reference.space_id.clone(), Some(record));
                                    spaces
                                        .get(&reference.space_id)
                                        .and_then(Option::as_ref)
                                        .expect("inserted space")
                                }
                                Ok(_)
                                | Err(PortError::Domain(
                                    DomainError::ResourceNotFound | DomainError::AccessDenied,
                                )) => {
                                    spaces.insert(reference.space_id.clone(), None);
                                    continue;
                                }
                                Err(error) => return Err(error),
                            }
                        };
                        match folder_metadata_cached(
                            tx,
                            ctx.auth(),
                            space,
                            reference.clone(),
                            &mut ancestry,
                        )
                        .await
                        {
                            Ok((folder, row)) => {
                                if project_info(folder, row).is_ok() {
                                    out.push(reference);
                                }
                            }
                            Err(PortError::Domain(
                                DomainError::ResourceNotFound | DomainError::AccessDenied,
                            )) => {}
                            Err(error) => return Err(error),
                        }
                    }
                    Ok(out)
                })
            })
            .await
        })
    }
    fn space(&self, budget: CallBudget, id: SpaceId) -> PortFuture<'_, CatalogSpace> {
        Box::pin(async move {
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move { Ok(catalog_space(load_space_record(tx, &id).await?)) })
            })
            .await
        })
    }
    fn project(&self, ctx: SpaceContext, reference: FolderRef) -> PortFuture<'_, ProjectInfo> {
        Box::pin(async move {
            let budget = ctx.budget.clone();
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let space = load_space_record(tx, &ctx.scope().space_id).await?;
                    ctx.check_current(&space.scope)?;
                    let (folder, row) = folder_metadata(tx, ctx.auth(), &space, reference).await?;
                    project_info(folder, row)
                })
            })
            .await
        })
    }
    fn project_by_slug(&self, ctx: SpaceContext, slug: String) -> PortFuture<'_, ProjectInfo> {
        Box::pin(async move {
            let slug = normalize_slug_key(&slug)?;
            let budget = ctx.budget.clone();
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let space = load_space_record(tx, &ctx.scope().space_id).await?;
                    ctx.check_current(&space.scope)?;
                    let id: Option<String> = db!(
                        read tx,
                        sqlx::query_scalar("SELECT folder_id FROM folder_heads
                            WHERE space_id=$1 AND project_slug_fold=$2
                              AND lifecycle_state='active' AND is_project=1"),
                        fetch_optional,
                        space.space.id.as_str(),
                        &slug
                    )?;
                    let id: String = if let Some(id) = id {
                        id
                    } else {
                        db!(
                            read tx,
                            sqlx::query_scalar("SELECT h.folder_id FROM folder_aliases a
                                JOIN folder_heads h ON h.space_id=a.space_id AND h.folder_id=a.target_folder_id
                                WHERE a.space_id=$1 AND a.old_parent_folder_id=$2 AND a.old_slug_fold=$3
                                  AND h.parent_folder_id=$2 AND h.lifecycle_state='active' AND h.is_project=1
                                ORDER BY a.created_seq DESC LIMIT 1"),
                            fetch_optional,
                            space.space.id.as_str(),
                            space.root_folder_id.as_str(),
                            &slug
                        )?.ok_or(DomainError::ResourceNotFound)?
                    };
                    let reference = FolderRef {
                        space_id: space.space.id.clone(),
                        folder_id: FolderId::parse(&id)?,
                    };
                    let (folder, row) = folder_metadata(tx, ctx.auth(), &space, reference).await?;
                    project_info(folder, row)
                })
            })
            .await
        })
    }
    fn projects(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProjectInfo>> {
        Box::pin(async move {
            let budget = ctx.budget.clone();
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let rec = load_space_record(tx, &ctx.scope().space_id).await?;
                    ctx.check_current(&rec.scope)?;
                    let grant = ctx
                        .auth()
                        .spaces()
                        .get(&rec.space.id)
                        .ok_or(DomainError::ResourceNotFound)?;
                    if rec.space.lifecycle != SpaceLifecycle::Active
                        || grant.read_classes.is_empty()
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let scope = digest((
                        "visible-projects-v2",
                        &rec.scope,
                        rec.last_seq,
                        ctx.auth().grant(),
                        ctx.auth().principal(),
                        &grant.project_root,
                        &grant.read_classes,
                    ))?;
                    let after = match continuation::<i64>(&page, &scope)? {
                        Some(seq) => cursor_entity(tx, &rec.space.id, "folder", seq).await?,
                        None => String::new(),
                    };
                    let pin = grant
                        .project_root
                        .as_ref()
                        .filter(|id| *id != &rec.root_folder_id);
                    let mut rows: Vec<(String, i64)> = db!(
                        read tx,
                        sqlx::query_as(LIST_PROJECTS),
                        fetch_all,
                        rec.space.id.as_str(),
                        &after,
                        pin.map_or("", FolderId::as_str),
                        i64::from(page.limit()) + 1
                    )?;
                    let next = if rows.len() > usize::from(page.limit()) {
                        rows.pop();
                        Some(encode_cursor(scope, rows.last().expect("nonempty page").1)?)
                    } else {
                        None
                    };
                    let mut items = Vec::with_capacity(rows.len());
                    for (id, _) in rows {
                        let reference = FolderRef {
                            space_id: rec.space.id.clone(),
                            folder_id: FolderId::parse(&id)?,
                        };
                        match folder_metadata(tx, ctx.auth(), &rec, reference).await {
                            Ok((folder, row)) => items.push(project_info(folder, row)?),
                            Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
                            Err(error) => return Err(error),
                        }
                    }
                    Ok(ControlPage {
                        items,
                        continuation: next,
                    })
                })
            })
            .await
        })
    }
    fn folder(&self, ctx: AccountContext, reference: FolderRef) -> PortFuture<'_, CatalogFolder> {
        Box::pin(async move {
            let budget = ctx.budget.clone();
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let rec = load_space_record(tx, &reference.space_id).await?;
                    Ok(folder_metadata(tx, ctx.auth(), &rec, reference).await?.0)
                })
            })
            .await
        })
    }
    fn note(&self, ctx: AccountContext, reference: NoteRef) -> PortFuture<'_, CatalogNote> {
        Box::pin(async move {
            let budget = ctx.budget.clone();
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let rec = load_space_record(tx, &reference.space_id).await?;
                    note_metadata(tx, ctx.auth(), &rec, reference).await
                })
            })
            .await
        })
    }
    fn locate_note(&self, ctx: AccountContext, note: NoteId) -> PortFuture<'_, CatalogNote> {
        Box::pin(async move {
            let spaces: Vec<String> = ctx
                .auth()
                .spaces()
                .keys()
                .map(|id| id.as_str().to_owned())
                .collect();
            if spaces.is_empty() {
                return Err(DomainError::ResourceNotFound.into());
            }
            let budget = ctx.budget.clone();
            self.with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let matched: Vec<String> = match tx {
                        BackendConn::Sqlite(conn) => {
                            let encoded = serde_json::to_string(&spaces).map_err(|err| {
                                internal_not_committed("encode_locate_note_spaces", err.to_string())
                            })?;
                            sqlx::query_scalar(
                                "SELECT space_id FROM note_heads
                                 WHERE space_id IN (SELECT value FROM json_each($1))
                                   AND note_id = $2
                                   AND lifecycle_state = 'active'
                                 ORDER BY space_id",
                            )
                            .bind(encoded)
                            .bind(note.as_str())
                            .fetch_all(&mut **conn)
                            .await
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query_scalar(
                                "SELECT space_id FROM note_heads
                                 WHERE space_id = ANY($1)
                                   AND note_id = $2
                                   AND lifecycle_state = 'active'
                                 ORDER BY space_id",
                            )
                            .bind(&spaces)
                            .bind(note.as_str())
                            .fetch_all(&mut **conn)
                            .await
                        }
                    }
                    .map_err(|err| crate::runtime::pg_read_error("locate_note", err))?;
                    for raw_space in matched {
                        let space_id = SpaceId::parse(&raw_space)?;
                        let rec = match load_space_record(tx, &space_id).await {
                            Ok(rec) => rec,
                            Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                            Err(err) => return Err(err),
                        };
                        let reference = NoteRef {
                            space_id,
                            note_id: note.clone(),
                        };
                        match note_metadata(tx, ctx.auth(), &rec, reference).await {
                            Ok(found) => return Ok(found),
                            Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                            Err(err) => return Err(err),
                        }
                    }
                    Err(DomainError::ResourceNotFound.into())
                })
            })
            .await
        })
    }
    fn abilities(
        &self,
        ctx: AccountContext,
        query: AbilityQuery,
    ) -> PortFuture<'_, ControlPage<AbilityDescriptor>> {
        Box::pin(abilities::page(self, ctx, query))
    }
    fn ability(&self, ctx: AccountContext, r: AbilityRef) -> PortFuture<'_, AbilityDescriptor> {
        Box::pin(abilities::lookup(self, ctx, r.identity(), Some(r.revision)))
    }
    fn current_ability(
        &self,
        ctx: AccountContext,
        id: AbilityIdentity,
    ) -> PortFuture<'_, AbilityDescriptor> {
        Box::pin(abilities::lookup(self, ctx, id, None))
    }
    fn locate_ability(
        &self,
        ctx: AccountContext,
        id: AbilityId,
    ) -> PortFuture<'_, Vec<AbilityDescriptor>> {
        Box::pin(abilities::locate(self, ctx, id))
    }
    fn pin_schedule_abilities(
        &self,
        ctx: AccountContext,
        refs: Vec<AbilityRef>,
    ) -> PortFuture<'_, Box<dyn ScheduleAbilityLease>> {
        Box::pin(abilities::pin_schedule(self, ctx, refs))
    }
    fn ensure_space(
        &self,
        budget: CallBudget,
        r: EnsureCatalogSpace,
    ) -> PortFuture<'_, CatalogSpace> {
        Box::pin(commands::ensure(self, budget, r))
    }
    fn change_lifecycle(
        &self,
        budget: CallBudget,
        id: AccountCommandIdentity,
        scope: HistoryScope,
        lifecycle: SpaceLifecycle,
    ) -> PortFuture<'_, CatalogSpace> {
        Box::pin(commands::lifecycle(self, budget, id, scope, lifecycle))
    }
    fn resolve_or_ensure_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, ResolvedMemoryTarget> {
        Box::pin(memory::resolve(self, ctx, target, category))
    }

    fn inspect_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, MemoryTargetSnapshot> {
        Box::pin(async move { memory::inspect(self, &ctx, target, category, true).await })
    }
}
