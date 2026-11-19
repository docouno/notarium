use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceLifecycle},
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, SpaceSeq},
    model::{FolderRef, Lifecycle, NoteRef, PathTarget},
    ports::{
        ChildFolders, CommandSeqRange, EnsureFolderPath, FolderSnapshot, Mutation, PageLimit,
        SpaceContext,
    },
    query::FieldSchema,
    receipt::MutationReceiptToken,
    value::Timestamp,
};

use crate::{
    CanonicalStore, SpaceRecord,
    changes::{EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft},
    codec::{
        FolderRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload,
        encode_timestamp_parts, internal_not_committed, new_prefixed_hex_id, new_revision_id,
        normalize_slug_key, now_utc_timestamp, ordered_id_16,
    },
    runtime::{insert_revision_row, load_folder_head_row, load_space_record},
    sql_exec::BackendConn,
    writer::{
        BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent,
        replay::{ReplayPolicy, ReplayResource},
    },
};

use super::{
    common::{
        CommandDeadline, FolderAncestryCache, MAX_FOLDER_DEPTH, StoredCommittedFolderRefV1,
        derive_command_identity_spec, extract_agent_run_from_auth, load_current_space_schema_tx,
        load_note_head_row_tx, require_empty_preconditions, validate_mutation_identity,
    },
    folders::{folder_mutation_class, is_note_live_readable_tx, resolve_folder_component_tx},
};

fn components(path: &str) -> Result<Vec<(String, String)>, PortError> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    path.split('/')
        .enumerate()
        .map(|(index, slug)| {
            if index >= MAX_FOLDER_DEPTH {
                return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
            }
            Ok((slug.to_owned(), normalize_slug_key(slug)?))
        })
        .collect()
}

fn if_visible<T>(result: Result<T, PortError>) -> Result<Option<T>, PortError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) async fn resolve(
    store: &CanonicalStore,
    ctx: SpaceContext,
    base: Option<FolderId>,
    path: String,
) -> Result<Option<FolderSnapshot>, PortError> {
    resolve_with_components(store, &ctx, base, components(&path)?, true).await
}

async fn resolve_with_components(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    base: Option<FolderId>,
    components: Vec<(String, String)>,
    aliases: bool,
) -> Result<Option<FolderSnapshot>, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let confirmed = ctx.confirmed_chat_step().cloned();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                if let Some(step) = &confirmed {
                    crate::chats::verify_confirmed_chat_step_tx(
                        tx,
                        &auth,
                        &scope,
                        step,
                        "ensure_folder_path",
                        false,
                    )
                    .await?;
                }
                let mut folders = FolderAncestryCache::default();
                let base = base.unwrap_or_else(|| space.root_folder_id.clone());
                let ancestry = if_visible(
                    folders
                        .load_ancestry_tx(tx, &scope.space_id, &base, true)
                        .await,
                )?;
                let Some(ancestry) = ancestry else {
                    return Ok(None);
                };
                if auth
                    .can_view_folder(&space.space, &base, &ancestry.ancestors)
                    .is_err()
                {
                    return Ok(None);
                }
                let mut parent = base.clone();
                for (_, folded) in components {
                    let Some(found) =
                        resolve_folder_component_tx(tx, &space, &auth, &parent, &folded, aliases)
                            .await?
                    else {
                        return Ok(None);
                    };
                    parent = found.folder_id;
                }
                if_visible(snapshot(tx, &space, &auth, &mut folders, &parent, Some(&base)).await)
            })
        })
        .await
}

pub(super) async fn list_children(
    store: &CanonicalStore,
    ctx: SpaceContext,
    base: Option<FolderId>,
    after: Option<FolderId>,
    limit: PageLimit,
) -> Result<ChildFolders, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let base = base.unwrap_or_else(|| space.root_folder_id.clone());
                let mut folders = FolderAncestryCache::default();
                let ancestry = folders.load_ancestry_tx(tx, &scope.space_id, &base, true).await?;
                auth.authorize_folder_read(&space.space, &base, &ancestry.ancestors)?;

                let sql = "SELECT folder_id FROM folder_heads
                    WHERE space_id=$1 AND parent_folder_id=$2 AND folder_id>$3 AND lifecycle_state='active'
                    ORDER BY folder_id LIMIT $4";
                let after = after.as_ref().map_or("", FolderId::as_str);
                let size = usize::from(limit.get());
                let raw: Vec<String> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(sql)
                        .bind(scope.space_id.as_str()).bind(base.as_str()).bind(after)
                        .bind(i64::from(limit.get()) + 1).fetch_all(&mut **conn).await,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(sql)
                        .bind(scope.space_id.as_str()).bind(base.as_str()).bind(after)
                        .bind(i64::from(limit.get()) + 1).fetch_all(&mut **conn).await,
                }.map_err(|err| crate::runtime::pg_read_error("list_child_folders", err))?;
                let mut items = Vec::with_capacity(raw.len().min(size));
                for entry in raw.iter().take(size) {
                    let id = FolderId::parse(entry)?;
                    items.push(snapshot(tx, &space, &auth, &mut folders, &id, Some(&base)).await?);
                }
                let next = if raw.len() > size {
                    items.last().map(|last| last.reference.folder_id.clone())
                } else {
                    None
                };
                Ok(ChildFolders { items, next })
            })
        })
        .await
}

async fn snapshot(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    auth: &EngineAuthContext,
    folders: &mut FolderAncestryCache,
    id: &FolderId,
    base: Option<&FolderId>,
) -> Result<FolderSnapshot, PortError> {
    let ancestry = folders
        .load_ancestry_tx(tx, &space.scope.space_id, id, true)
        .await?;
    if base.is_some_and(|base| !ancestry.ancestors.contains(base)) {
        return Err(DomainError::ResourceNotFound.into());
    }
    auth.authorize_folder_read(&space.space, id, &ancestry.ancestors)?;
    let row = load_folder_head_row(tx, &space.scope.space_id, id).await?;
    let cover_note = match row.cover_note_id {
        Some(note) if is_note_live_readable_tx(tx, &space.space, auth, &note).await? => Some(note),
        _ => None,
    };
    Ok(FolderSnapshot {
        reference: FolderRef {
            space_id: space.scope.space_id.clone(),
            folder_id: row.folder_id,
        },
        history: space.scope.clone(),
        revision: row.head_rev_id,
        path: ancestry.folder_path,
        name: row.display_name,
        parent: row.parent_folder_id,
        project: ancestry.project,
        cover_note,
    })
}

pub(super) async fn resolve_note(
    store: &CanonicalStore,
    ctx: SpaceContext,
    parent: Option<FolderId>,
    target: String,
) -> Result<Option<NoteRef>, PortError> {
    let note_id = match NoteId::parse(&target) {
        Ok(note) => note,
        Err(_) => {
            let Some(found) = store
                .resolve_note_alias(ctx.clone(), parent, &target)
                .await?
            else {
                return Ok(None);
            };
            found.note_id
        }
    };
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let Some(head) =
                    if_visible(load_note_head_row_tx(tx, &scope.space_id, &note_id).await)?
                else {
                    return Ok(None);
                };
                if head.doc_class == notarium_core::classes::DocClass::EncryptedNote
                    || !is_note_live_readable_tx(tx, &space.space, &auth, &note_id).await?
                {
                    return Ok(None);
                }
                Ok(Some(NoteRef {
                    space_id: scope.space_id,
                    note_id,
                }))
            })
        })
        .await
}

pub(super) async fn space_schema(
    store: &CanonicalStore,
    ctx: SpaceContext,
) -> Result<BTreeMap<String, FieldSchema>, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let grant = auth
                    .spaces()
                    .get(&scope.space_id)
                    .ok_or(DomainError::ResourceNotFound)?;
                let base = grant.project_root.as_ref().unwrap_or(&space.root_folder_id);
                let facts = FolderAncestryCache::default()
                    .load_ancestry_tx(tx, &scope.space_id, base, true)
                    .await?;
                auth.can_view_folder(&space.space, base, &facts.ancestors)?;
                Ok(load_current_space_schema_tx(tx, &scope.space_id)
                    .await?
                    .map_or_else(BTreeMap::new, |schema| schema.fields))
            })
        })
        .await
}

pub(super) async fn ensure(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<EnsureFolderPath>,
) -> Result<FolderRef, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    require_empty_preconditions(&request.preconditions)?;
    let parts = components(&request.input.path)?;
    let budget = ctx.budget.clone();
    let deadline = CommandDeadline::start(&budget, "ensure_folder_path");
    let space = deadline
        .prepare(&budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&budget))
        })
        .await?;
    space.scope.check(ctx.scope())?;
    let base = request
        .input
        .base
        .unwrap_or_else(|| space.root_folder_id.clone());
    let hash = format!("{}\0{}", base.as_str(), request.input.path);
    let idemp =
        derive_command_identity_spec(&request.identity, "ensure_folder_path", hash.as_bytes())
            .with_confirmed_chat_step(&ctx, "ensure_folder_path")
            .with_policy(
                ctx.auth(),
                ReplayPolicy::Documents(vec![ReplayResource::WriteFolder(Some(base.clone()))]),
            );
    let replay = deadline
        .prepare(&budget, || {
            super::notes::try_replay_completed_receipt::<StoredCommittedFolderRefV1>(
                store,
                &space.scope,
                &idemp,
                Some(&budget),
            )
        })
        .await?;
    if let Some(replay) = replay {
        ctx.budget.remaining = deadline.remaining(&budget)?;
        return verify_ensured_folder(store, &ctx, base, replay.into_committed().value).await;
    }
    ctx.budget.remaining = deadline.remaining(&budget)?;
    if let Some(found) =
        resolve_with_components(store, &ctx, Some(base.clone()), parts.clone(), false).await?
    {
        return Ok(found.reference);
    }
    ctx.budget.remaining = deadline.remaining(&budget)?;

    let intent = {
        let scope = space.scope.clone();
        let auth = ctx.auth().clone();
        let base = base.clone();
        let parts = parts.clone();
        PreparedWriteIntent {
            scope: space.scope.clone(),
            active_epoch: space.active_epoch,
            idempotency: Some(idemp),
            source_note_ids: Vec::new(),
            staged_bytes: 0,
            required_semantic_cut: None,
            execute: Box::new(move |tx, item| {
                Box::pin(async move {
                    let live = load_space_record(tx, &scope.space_id).await?;
                    live.scope.check(&scope)?;
                    if live.space.lifecycle != SpaceLifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let mut folder = base.clone();
                    let mut existing_count = 0;
                    for (_, folded) in &parts {
                        let Some(found) =
                            resolve_folder_component_tx(tx, &live, &auth, &folder, folded, false)
                                .await?
                        else {
                            break;
                        };
                        folder = found.folder_id;
                        existing_count += 1;
                    }
                    let missing = &parts[existing_count..];
                    if missing.is_empty() {
                        return Err(DomainError::PathConflict {
                            target: PathTarget {
                                space_id: scope.space_id,
                                parent: Some(base),
                                component: String::new(),
                            },
                        }
                        .into());
                    }
                    let class = folder_mutation_class(&auth, &scope.space_id)?;
                    let mut cache = FolderAncestryCache::default();
                    let (facts, ancestry) = cache
                        .build_resource_facts_tx(tx, &live.space, &folder, class, None, true)
                        .await?;
                    auth.authorize_direct_write(&facts, &facts)?;
                    if ancestry.ancestors.len().saturating_sub(1) + missing.len() > MAX_FOLDER_DEPTH
                    {
                        return Err(DomainError::validation(
                            ValidationReason::InvalidPathComponent,
                        )
                        .into());
                    }

                    let (first, last) = item.preview_seq_range(missing.len() as u64)?;
                    let mut events = Vec::with_capacity(missing.len());
                    let now = now_utc_timestamp()?;
                    let run = extract_agent_run_from_auth(&auth);
                    for (slug, folded) in missing {
                        let id = FolderId::from_bytes(ordered_id_16()?);
                        let seq = item.alloc_next_seq()?;
                        events.push(
                            insert_child(
                                tx, &live, &auth, &folder, &id, slug, folded, seq, last, now,
                            )
                            .await?,
                        );
                        folder = id;
                    }
                    if let Some(run) = run {
                        super::common::upsert_agent_run_head_tx(
                            tx,
                            &scope,
                            &run,
                            auth.principal(),
                            first,
                            last,
                            now,
                        )
                        .await?;
                    }
                    let command_id = new_prefixed_hex_id("cmd_")?;
                    let payload = build_effect_payload_draft(
                        format!("eff:{command_id}"),
                        scope.clone(),
                        CommandSeqRange::new(first, last)?,
                        "ensure_folder_path",
                        EffectBodyV1::AwaitProjection {
                            reason: StoredAwaitReasonV1::Structural,
                        },
                        vec![],
                    )?;
                    let response = StoredCommittedFolderRefV1 {
                        value: FolderRef {
                            space_id: scope.space_id.clone(),
                            folder_id: folder,
                        },
                        receipt: MutationReceiptToken::new(scope, last)?,
                    };
                    let bytes = CanonicalStore::encode_command_outcome(&response)?;
                    Ok(ItemCommitArtifacts {
                        command_id,
                        command_kind: "ensure_folder_path".to_owned(),
                        events,
                        change_payload: Some(payload),
                        receipt_detail_blob: None,
                        receipt_sanitized_blob: bytes.clone(),
                        receipt_owner_note_ids: vec![],
                        response_bytes: bytes,
                    })
                })
            }),
        }
    };
    match deadline
        .submit::<StoredCommittedFolderRefV1>(store, &ctx.budget, intent)
        .await
    {
        Ok(result) => Ok(result.into_committed().value),
        Err(PortError::Domain(DomainError::PathConflict { .. })) => {
            ctx.budget.remaining = deadline.remaining(&budget)?;
            resolve_with_components(store, &ctx, Some(base), parts, false)
                .await?
                .map(|found| found.reference)
                .ok_or(DomainError::ResourceNotFound.into())
        }
        Err(err) => Err(err),
    }
}

async fn verify_ensured_folder(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    base: FolderId,
    reference: FolderRef,
) -> Result<FolderRef, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let confirmed = ctx.confirmed_chat_step().cloned();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                if let Some(step) = &confirmed {
                    crate::chats::verify_confirmed_chat_step_tx(
                        tx,
                        &auth,
                        &scope,
                        step,
                        "ensure_folder_path",
                        false,
                    )
                    .await?;
                }
                if reference.space_id != scope.space_id {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let mut folders = FolderAncestryCache::default();
                snapshot(
                    tx,
                    &space,
                    &auth,
                    &mut folders,
                    &reference.folder_id,
                    Some(&base),
                )
                .await?;
                Ok(reference)
            })
        })
        .await
}

#[allow(clippy::too_many_arguments)]
async fn insert_child(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    auth: &EngineAuthContext,
    parent: &FolderId,
    id: &FolderId,
    slug: &str,
    folded: &str,
    seq: SpaceSeq,
    visibility: SpaceSeq,
    now: Timestamp,
) -> Result<BatchEventDraft, PortError> {
    let revision = new_revision_id()?;
    let (sec, nsec) = encode_timestamp_parts(now);
    let scope = &space.scope;
    let sql = "INSERT INTO folder_heads (
        space_id, folder_id, parent_folder_id, is_root, slug, slug_fold, display_name,
        is_project, lifecycle_state, rev_seq, head_rev_id, created_seq, updated_seq,
        updated_at_sec, updated_at_nsec
    ) VALUES ($1, $2, $3, 0, $4, $5, $4, 0, 'active', $6, $7, $6, $6, $8, $9)";
    macro_rules! insert {
        ($conn:expr) => {
            sqlx::query(sql)
                .bind(scope.space_id.as_str())
                .bind(id.as_str())
                .bind(parent.as_str())
                .bind(slug)
                .bind(folded)
                .bind(seq.get() as i64)
                .bind(revision.as_str())
                .bind(sec)
                .bind(nsec)
                .execute($conn)
                .await
                .map_err(|err| internal_not_committed("insert_ensured_folder", err.to_string()))?
        };
    }
    match tx {
        BackendConn::Sqlite(conn) => {
            insert!(&mut **conn);
        }
        BackendConn::Postgres(conn) => {
            insert!(&mut **conn);
        }
    }
    let metadata =
        RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(FolderRevisionMetadata {
            folder_id: id.clone(),
            parent_folder_id: Some(parent.clone()),
            is_root: false,
            slug: slug.to_owned(),
            slug_fold: folded.to_owned(),
            display_name: slug.to_owned(),
            is_project: false,
            project_slug: None,
            description: None,
            cover_note_id: None,
            write_locked: false,
            lifecycle: Lifecycle::Active,
        }))
        .encode()?;
    let run = extract_agent_run_from_auth(auth);
    insert_revision_row(
        tx,
        scope,
        &revision,
        "folder",
        id.as_str(),
        seq,
        visibility,
        None,
        None,
        None,
        &metadata,
        auth.principal(),
        run.as_ref(),
        now,
    )
    .await?;
    Ok(BatchEventDraft {
        space_seq: seq,
        entity_type: "folder".to_owned(),
        entity_id: id.as_str().to_owned(),
        op_kind: "create".to_owned(),
        rev_id: revision,
        lifecycle: Lifecycle::Active,
        doc_class: None,
    })
}
