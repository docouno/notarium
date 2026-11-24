use std::collections::BTreeSet;

use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, SpaceSeq},
    model::{FolderRef, Lifecycle, NoteRef, PathTarget},
    ports::{Committed, MoveFolder, Mutation, RenameFolder, RenameProject, SpaceContext},
    receipt::MutationReceiptToken,
};
use sqlx::Row;

use crate::{
    CanonicalStore,
    changes::{EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft},
    codec::{
        FolderRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload,
        encode_timestamp_parts, internal_not_committed, new_prefixed_hex_id, new_revision_id,
        normalize_slug_key, normalize_title_key, now_utc_timestamp,
    },
    domain::common::{
        FolderAncestryCache, MAX_FOLDER_DEPTH, StoredCommittedFolderRefV1,
        active_note_sibling_exists_tx, build_resource_facts_tx, derive_command_identity_spec,
        extract_agent_run_from_auth, insert_folder_alias_tx, load_folder_ancestry_tx,
        load_note_head_row_opt_tx, upsert_agent_run_head_tx, validate_mutation_identity,
    },
    runtime::{
        active_folder_sibling_exists, active_project_slug_exists, insert_revision_row,
        is_note_purge_fenced_tx, load_folder_head_row, load_space_record,
    },
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};

pub(crate) async fn move_folder_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<MoveFolder>,
) -> Result<Committed<FolderRef>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "move_folder");
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_revision_only(&request.preconditions)?;
    let target_write_class = folder_mutation_class(ctx.auth(), &ctx.scope().space_id)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!(
        "folder={}\0new_parent={}",
        request.input.folder.as_str(),
        request
            .input
            .new_parent
            .as_ref()
            .map(FolderId::as_str)
            .unwrap_or("<root>")
    );
    let idemp = derive_command_identity_spec(&ctx, &request.identity, "move_folder", fp.as_bytes())
        .with_preconditions(
            &request.preconditions,
            "folder",
            request.input.folder.as_str(),
        )
        .with_policy(
            ctx.auth(),
            crate::writer::replay::ReplayPolicy::Documents(vec![
                crate::writer::replay::ReplayResource::WriteFolder(Some(
                    request.input.folder.clone(),
                )),
                crate::writer::replay::ReplayResource::WriteFolder(
                    request.input.new_parent.clone(),
                ),
            ]),
        );

    let auth = ctx.auth().clone();
    let preconditions = request.preconditions.clone();
    let input = request.input.clone();
    let scope = space_rec.scope.clone();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                let folder_row = load_folder_head_row(tx, &scope.space_id, &input.folder).await?;
                if folder_row.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let dest_parent = input
                    .new_parent
                    .clone()
                    .unwrap_or_else(|| item_ctx.root_folder_id.clone());
                let before_anc =
                    load_folder_ancestry_tx(tx, &scope.space_id, &input.folder, true).await?;
                let dest_anc =
                    load_folder_ancestry_tx(tx, &scope.space_id, &dest_parent, true).await?;
                let crosses_ability_scope =
                    !folder_row.is_project && before_anc.project != dest_anc.project;
                let destination_project = dest_anc.project.clone();

                let would_cycle = dest_anc.ancestors.contains(&input.folder);
                let old_depth = before_anc.ancestors.len() - 1;
                let new_depth = dest_anc.ancestors.len();
                let before_facts = notarium_core::auth::ResourceFacts {
                    space: live_space.space.clone(),
                    class: target_write_class,
                    project: before_anc.project,
                    ancestor_folders: before_anc.ancestors,
                    folder_write_locked: before_anc.write_locked,
                    ability_package: None,
                };
                let mut after_ancestors = Vec::with_capacity(dest_anc.ancestors.len() + 1);
                after_ancestors.push(input.folder.clone());
                after_ancestors.extend(dest_anc.ancestors);
                let after_facts = notarium_core::auth::ResourceFacts {
                    space: live_space.space.clone(),
                    class: target_write_class,
                    project: if folder_row.is_project {
                        Some(input.folder.clone())
                    } else {
                        destination_project.clone()
                    },
                    ancestor_folders: after_ancestors,
                    folder_write_locked: folder_row.write_locked || dest_anc.write_locked,
                    ability_package: None,
                };
                auth.authorize_direct_write(&before_facts, &after_facts)?;

                if folder_row.is_root {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != folder_row.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: folder_row.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                if dest_parent == input.folder {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if folder_row.is_project && dest_parent != item_ctx.root_folder_id {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }

                // O(depth) cycle prevention under Space write lock: moving a folder into any of its own descendants is forbidden.
                if would_cycle {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }

                // Descendants retain their relative depth. Only a deeper destination
                // can push a previously valid path beyond the absolute limit.
                if new_depth > MAX_FOLDER_DEPTH
                    || (new_depth > old_depth
                        && subtree_reaches_depth_tx(
                            tx,
                            &scope.space_id,
                            &input.folder,
                            MAX_FOLDER_DEPTH - new_depth + 1,
                        )
                        .await?)
                {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }

                let old_parent = folder_row.parent_folder_id.clone().ok_or_else(|| {
                    internal_not_committed("folder_missing_parent", "non-root folder lacks parent")
                })?;

                if dest_parent != old_parent
                    && active_folder_sibling_exists(
                        tx,
                        &scope.space_id,
                        &dest_parent,
                        &folder_row.slug_fold,
                    )
                    .await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope.space_id.clone(),
                            parent: input.new_parent.clone(),
                            component: folder_row.slug.clone(),
                        },
                    }
                    .into());
                }

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

                // Update ONLY the moved folder's own head row; 0 descendant note_heads or CAS rewrites!
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET parent_folder_id = ?, rev_seq = rev_seq + 1, head_rev_id = ?,
                                 updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                             WHERE space_id = ? AND folder_id = ?",
                        )
                        .bind(dest_parent.as_str())
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.folder.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_move_folder", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET parent_folder_id = $1, rev_seq = rev_seq + 1, head_rev_id = $2,
                                 updated_seq = $3, updated_at_sec = $4, updated_at_nsec = $5
                             WHERE space_id = $6 AND folder_id = $7",
                        )
                        .bind(dest_parent.as_str())
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.folder.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_move_folder", err.to_string()))?;
                    }
                }

                if crosses_ability_scope {
                    let sql = include_str!("moved_ability_slots.sql");
                    let project = destination_project.as_ref().map_or("", FolderId::as_str);
                    let state: i64 = match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query_scalar(sql)
                                .bind(scope.space_id.as_str())
                                .bind(input.folder.as_str())
                                .bind(project)
                                .fetch_one(&mut **conn)
                                .await
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query_scalar(sql)
                                .bind(scope.space_id.as_str())
                                .bind(input.folder.as_str())
                                .bind(project)
                                .fetch_one(&mut **conn)
                                .await
                        }
                    }
                    .map_err(|err| {
                        internal_not_committed("moved_ability_slots", err.to_string())
                    })?;
                    if state != 0 {
                        auth.authorize_ability_mutation()?;
                    }
                    if state == 2 {
                        return Err(DomainError::PathConflict {
                            target: PathTarget {
                                space_id: scope.space_id.clone(),
                                parent: input.new_parent.clone(),
                                component: folder_row.slug.clone(),
                            },
                        }
                        .into());
                    }
                }

                if dest_parent != old_parent {
                    insert_folder_alias_tx(
                        tx,
                        &scope.space_id,
                        &old_parent,
                        &folder_row.slug_fold,
                        &input.folder,
                        seq,
                    )
                    .await?;
                }

                let run_opt = extract_agent_run_from_auth(&auth);
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(
                    FolderRevisionMetadata {
                        confirmation: None,
                        folder_id: input.folder.clone(),
                        parent_folder_id: Some(dest_parent),
                        is_root: false,
                        slug: folder_row.slug,
                        slug_fold: folder_row.slug_fold,
                        display_name: folder_row.display_name,
                        is_project: folder_row.is_project,
                        project_slug: folder_row.project_slug,
                        description: folder_row.description,
                        cover_note_id: folder_row.cover_note_id,
                        write_locked: folder_row.write_locked,
                        lifecycle: Lifecycle::Active,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &new_rev,
                    "folder",
                    input.folder.as_str(),
                    seq,
                    seq,
                    Some(&folder_row.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "move_folder",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::Structural,
                    },
                    Vec::new(),
                )?;

                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedFolderRefV1 {
                    value: FolderRef {
                        space_id: scope.space_id.clone(),
                        folder_id: input.folder.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "move_folder".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "folder".to_owned(),
                        entity_id: input.folder.as_str().to_owned(),
                        op_kind: "move".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedFolderRefV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(crate) async fn rename_folder_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<RenameFolder>,
) -> Result<Committed<FolderRef>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "rename_folder");
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_revision_only(&request.preconditions)?;
    let new_slug_fold = normalize_slug_key(&request.input.name)?;
    let target_write_class = folder_mutation_class(ctx.auth(), &ctx.scope().space_id)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!(
        "folder={}\0name={}",
        request.input.folder.as_str(),
        request.input.name
    );
    let idemp =
        derive_command_identity_spec(&ctx, &request.identity, "rename_folder", fp.as_bytes())
            .with_preconditions(
                &request.preconditions,
                "folder",
                request.input.folder.as_str(),
            )
            .with_policy(
                ctx.auth(),
                crate::writer::replay::ReplayPolicy::Documents(vec![
                    crate::writer::replay::ReplayResource::WriteFolder(Some(
                        request.input.folder.clone(),
                    )),
                ]),
            );

    let auth = ctx.auth().clone();
    let preconditions = request.preconditions.clone();
    let input = request.input.clone();
    let scope = space_rec.scope.clone();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                let folder_row = load_folder_head_row(tx, &scope.space_id, &input.folder).await?;
                if folder_row.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let anc = load_folder_ancestry_tx(tx, &scope.space_id, &input.folder, true).await?;
                let facts = notarium_core::auth::ResourceFacts {
                    space: live_space.space.clone(),
                    class: target_write_class,
                    project: anc.project,
                    ancestor_folders: anc.ancestors,
                    folder_write_locked: anc.write_locked,
                    ability_package: None,
                };
                auth.authorize_direct_write(&facts, &facts)?;

                if folder_row.is_root {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != folder_row.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: folder_row.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                let parent_id = folder_row.parent_folder_id.clone().ok_or_else(|| {
                    internal_not_committed("folder_missing_parent", "non-root folder lacks parent")
                })?;

                if new_slug_fold != folder_row.slug_fold
                    && active_folder_sibling_exists(tx, &scope.space_id, &parent_id, &new_slug_fold)
                        .await?
                {
                    let report_parent =
                        (parent_id != item_ctx.root_folder_id).then_some(parent_id.clone());
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope.space_id.clone(),
                            parent: report_parent,
                            component: input.name.clone(),
                        },
                    }
                    .into());
                }

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET slug = ?, slug_fold = ?, display_name = ?,
                                 rev_seq = rev_seq + 1, head_rev_id = ?,
                                 updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                             WHERE space_id = ? AND folder_id = ?",
                        )
                        .bind(&input.name)
                        .bind(&new_slug_fold)
                        .bind(&input.name)
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.folder.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_rename_folder", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET slug = $1, slug_fold = $2, display_name = $3,
                                 rev_seq = rev_seq + 1, head_rev_id = $4,
                                 updated_seq = $5, updated_at_sec = $6, updated_at_nsec = $7
                             WHERE space_id = $8 AND folder_id = $9",
                        )
                        .bind(&input.name)
                        .bind(&new_slug_fold)
                        .bind(&input.name)
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.folder.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_rename_folder", err.to_string())
                        })?;
                    }
                }

                if new_slug_fold != folder_row.slug_fold {
                    insert_folder_alias_tx(
                        tx,
                        &scope.space_id,
                        &parent_id,
                        &folder_row.slug_fold,
                        &input.folder,
                        seq,
                    )
                    .await?;
                }

                let run_opt = extract_agent_run_from_auth(&auth);
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(
                    FolderRevisionMetadata {
                        confirmation: None,
                        folder_id: input.folder.clone(),
                        parent_folder_id: Some(parent_id),
                        is_root: false,
                        slug: input.name.clone(),
                        slug_fold: new_slug_fold,
                        display_name: input.name,
                        is_project: folder_row.is_project,
                        project_slug: folder_row.project_slug,
                        description: folder_row.description,
                        cover_note_id: folder_row.cover_note_id,
                        write_locked: folder_row.write_locked,
                        lifecycle: Lifecycle::Active,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &new_rev,
                    "folder",
                    input.folder.as_str(),
                    seq,
                    seq,
                    Some(&folder_row.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "rename_folder",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::Structural,
                    },
                    Vec::new(),
                )?;

                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedFolderRefV1 {
                    value: FolderRef {
                        space_id: scope.space_id.clone(),
                        folder_id: input.folder.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "rename_folder".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "folder".to_owned(),
                        entity_id: input.folder.as_str().to_owned(),
                        op_kind: "rename".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedFolderRefV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(crate) async fn rename_project_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<RenameProject>,
) -> Result<Committed<FolderRef>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "rename_project");
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_revision_only(&request.preconditions)?;
    let new_slug_fold = normalize_slug_key(&request.input.name)?;
    if let Some(display_name) = &request.input.display_name
        && (display_name.trim().is_empty() || display_name.chars().any(char::is_control))
    {
        return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
    }
    let target_write_class = folder_mutation_class(ctx.auth(), &ctx.scope().space_id)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = match &request.input.display_name {
        Some(display_name) => format!(
            "folder={}\0name={}\0display={display_name}",
            request.input.folder.as_str(),
            request.input.name,
        ),
        None => format!(
            "folder={}\0name={}\0display_keep=1",
            request.input.folder.as_str(),
            request.input.name,
        ),
    };
    let idemp =
        derive_command_identity_spec(&ctx, &request.identity, "rename_project", fp.as_bytes())
            .with_preconditions(
                &request.preconditions,
                "folder",
                request.input.folder.as_str(),
            )
            .with_policy(
                ctx.auth(),
                crate::writer::replay::ReplayPolicy::Documents(vec![
                    crate::writer::replay::ReplayResource::WriteFolder(Some(
                        request.input.folder.clone(),
                    )),
                ]),
            );

    let auth = ctx.auth().clone();
    let preconditions = request.preconditions.clone();
    let input = request.input.clone();
    let scope = space_rec.scope.clone();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                let folder_row = load_folder_head_row(tx, &scope.space_id, &input.folder).await?;
                if folder_row.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let anc = load_folder_ancestry_tx(tx, &scope.space_id, &input.folder, true).await?;
                let facts = notarium_core::auth::ResourceFacts {
                    space: live_space.space.clone(),
                    class: target_write_class,
                    project: anc.project,
                    ancestor_folders: anc.ancestors,
                    folder_write_locked: anc.write_locked,
                    ability_package: None,
                };
                auth.authorize_direct_write(&facts, &facts)?;

                if folder_row.is_root || !folder_row.is_project {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != folder_row.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: folder_row.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                if folder_row.parent_folder_id.as_ref() != Some(&live_space.root_folder_id) {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }

                let parent_id = folder_row.parent_folder_id.clone().ok_or_else(|| {
                    internal_not_committed("project_missing_parent", "project folder lacks parent")
                })?;
                let report_parent =
                    (parent_id != item_ctx.root_folder_id).then_some(parent_id.clone());

                if folder_row.project_slug_fold.as_deref() != Some(new_slug_fold.as_str())
                    && active_project_slug_exists(tx, &scope.space_id, &new_slug_fold).await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope.space_id.clone(),
                            parent: report_parent,
                            component: input.name.clone(),
                        },
                    }
                    .into());
                }

                if new_slug_fold != folder_row.slug_fold
                    && active_folder_sibling_exists(tx, &scope.space_id, &parent_id, &new_slug_fold)
                        .await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope.space_id.clone(),
                            parent: report_parent,
                            component: input.name.clone(),
                        },
                    }
                    .into());
                }

                let effective_display_name = match &input.display_name {
                    Some(name) => name.clone(),
                    None => {
                        if folder_row.display_name.trim().is_empty()
                            || folder_row.display_name.chars().any(char::is_control)
                        {
                            return Err(DomainError::validation(
                                ValidationReason::InvalidPathComponent,
                            )
                            .into());
                        }
                        folder_row.display_name.clone()
                    }
                };
                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET slug = ?, slug_fold = ?, display_name = ?,
                                 project_slug = ?, project_slug_fold = ?,
                                 rev_seq = rev_seq + 1, head_rev_id = ?,
                                 updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                             WHERE space_id = ? AND folder_id = ?",
                        )
                        .bind(&input.name)
                        .bind(&new_slug_fold)
                        .bind(&effective_display_name)
                        .bind(&input.name)
                        .bind(&new_slug_fold)
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.folder.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_rename_project", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET slug = $1, slug_fold = $2, display_name = $3,
                                 project_slug = $4, project_slug_fold = $5,
                                 rev_seq = rev_seq + 1, head_rev_id = $6,
                                 updated_seq = $7, updated_at_sec = $8, updated_at_nsec = $9
                             WHERE space_id = $10 AND folder_id = $11",
                        )
                        .bind(&input.name)
                        .bind(&new_slug_fold)
                        .bind(&effective_display_name)
                        .bind(&input.name)
                        .bind(&new_slug_fold)
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.folder.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_rename_project", err.to_string())
                        })?;
                    }
                }

                if new_slug_fold != folder_row.slug_fold {
                    insert_folder_alias_tx(
                        tx,
                        &scope.space_id,
                        &parent_id,
                        &folder_row.slug_fold,
                        &input.folder,
                        seq,
                    )
                    .await?;
                }

                let run_opt = extract_agent_run_from_auth(&auth);
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(
                    FolderRevisionMetadata {
                        confirmation: None,
                        folder_id: input.folder.clone(),
                        parent_folder_id: Some(parent_id),
                        is_root: false,
                        slug: input.name.clone(),
                        slug_fold: new_slug_fold,
                        display_name: effective_display_name,
                        is_project: true,
                        project_slug: Some(input.name),
                        description: folder_row.description,
                        cover_note_id: folder_row.cover_note_id,
                        write_locked: folder_row.write_locked,
                        lifecycle: Lifecycle::Active,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &new_rev,
                    "folder",
                    input.folder.as_str(),
                    seq,
                    seq,
                    Some(&folder_row.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "rename_project",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::Structural,
                    },
                    Vec::new(),
                )?;

                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedFolderRefV1 {
                    value: FolderRef {
                        space_id: scope.space_id.clone(),
                        folder_id: input.folder.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "rename_project".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "folder".to_owned(),
                        entity_id: input.folder.as_str().to_owned(),
                        op_kind: "rename".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedFolderRefV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(crate) async fn resolve_folder_alias_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    parent: Option<FolderId>,
    slug: &str,
) -> Result<Option<FolderRef>, PortError> {
    let slug_fold = normalize_slug_key(slug)?;
    let auth = ctx.auth().clone();
    let scope = ctx.scope().clone();

    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope.space_id).await?;
                space_rec.scope.check(&scope)?;
                if space_rec.space.lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let parent_id = parent.unwrap_or_else(|| space_rec.root_folder_id.clone());
                let mut cache = FolderAncestryCache::default();

                resolve_folder_component_tx(
                    tx, &space_rec, &auth, &parent_id, &slug_fold, true, &mut cache,
                )
                .await
            })
        })
        .await
}

pub(super) async fn resolve_folder_component_tx(
    tx: &mut BackendConn<'_>,
    space_rec: &crate::SpaceRecord,
    auth: &notarium_core::auth::EngineAuthContext,
    parent_id: &FolderId,
    slug_fold: &str,
    aliases: bool,
    cache: &mut FolderAncestryCache,
) -> Result<Option<FolderRef>, PortError> {
    let scope = &space_rec.scope;
    // 1. Exact active sibling takes priority over any historical alias!
    let active_sibling: Option<String> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT folder_id FROM folder_heads
             WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ?
               AND lifecycle_state = 'active' AND is_root = 0
             LIMIT 1",
        )
        .bind(scope.space_id.as_str())
        .bind(parent_id.as_str())
        .bind(slug_fold)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_resolve_folder_exact", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT folder_id FROM folder_heads
             WHERE space_id = $1 AND parent_folder_id = $2 AND slug_fold = $3
               AND lifecycle_state = 'active' AND is_root = 0
             LIMIT 1",
        )
        .bind(scope.space_id.as_str())
        .bind(parent_id.as_str())
        .bind(slug_fold)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| crate::runtime::pg_read_error("pg_resolve_folder_exact", err))?,
    };

    if let Some(fid_raw) = active_sibling {
        let fid = FolderId::parse(&fid_raw)
            .map_err(|_| internal_not_committed("corrupt_folder_id", "invalid folder_id"))?;
        if is_folder_readable_tx(tx, &space_rec.space, auth, &fid, cache).await? {
            return Ok(Some(FolderRef {
                space_id: scope.space_id.clone(),
                folder_id: fid,
            }));
        }
        return Ok(None);
    }

    if !aliases {
        return Ok(None);
    }

    // 2. Newest valid active alias target (with cycle/depth guard via ancestry check).
    let candidates: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT target_folder_id FROM folder_aliases
                 WHERE space_id = ? AND old_parent_folder_id = ? AND old_slug_fold = ?
                 ORDER BY created_seq DESC
                 LIMIT ?",
            )
            .bind(scope.space_id.as_str())
            .bind(parent_id.as_str())
            .bind(slug_fold)
            .bind(MAX_FOLDER_DEPTH as i64)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_resolve_folder_alias", err.to_string())
            })?;
            rows.into_iter()
                .map(|r| r.get("target_folder_id"))
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT target_folder_id FROM folder_aliases
                 WHERE space_id = $1 AND old_parent_folder_id = $2 AND old_slug_fold = $3
                 ORDER BY created_seq DESC
                 LIMIT $4",
            )
            .bind(scope.space_id.as_str())
            .bind(parent_id.as_str())
            .bind(slug_fold)
            .bind(MAX_FOLDER_DEPTH as i64)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_resolve_folder_alias", err))?;
            rows.into_iter()
                .map(|r| r.get("target_folder_id"))
                .collect()
        }
    };

    let mut seen = BTreeSet::new();
    for cand_raw in candidates {
        if !seen.insert(cand_raw.clone()) {
            continue;
        }
        let fid = FolderId::parse(&cand_raw).map_err(|_| {
            internal_not_committed("corrupt_alias_folder_id", "invalid target_folder_id")
        })?;
        if is_folder_readable_tx(tx, &space_rec.space, auth, &fid, cache).await? {
            return Ok(Some(FolderRef {
                space_id: scope.space_id.clone(),
                folder_id: fid,
            }));
        }
    }
    Ok(None)
}

pub(crate) async fn resolve_note_alias_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    parent: Option<FolderId>,
    slug_or_title: &str,
) -> Result<Option<NoteRef>, PortError> {
    let slug_fold_opt = normalize_slug_key(slug_or_title).ok();
    let title_norm = normalize_title_key(slug_or_title);
    if slug_fold_opt.is_none() && title_norm.is_empty() {
        return Ok(None);
    }
    let auth = ctx.auth().clone();
    let scope = ctx.scope().clone();

    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope.space_id).await?;
                space_rec.scope.check(&scope)?;
                if space_rec.space.lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let parent_id = parent.unwrap_or_else(|| space_rec.root_folder_id.clone());

                // 1. Exact active sibling by slug_fold in `parent_id`.
                if let Some(sf) = &slug_fold_opt {
                    let exact_slug: Option<String> = match tx {
                        BackendConn::Sqlite(conn) => sqlx::query_scalar(
                            "SELECT note_id FROM note_heads
                             WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ?
                               AND lifecycle_state = 'active'
                             LIMIT 1",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(parent_id.as_str())
                        .bind(sf)
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_resolve_note_slug", err.to_string())
                        })?,
                        BackendConn::Postgres(conn) => sqlx::query_scalar(
                            "SELECT note_id FROM note_heads
                             WHERE space_id = $1 AND parent_folder_id = $2 AND slug_fold = $3
                               AND lifecycle_state = 'active'
                             LIMIT 1",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(parent_id.as_str())
                        .bind(sf)
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            crate::runtime::pg_read_error("pg_resolve_note_slug", err)
                        })?,
                    };
                    if let Some(nid_raw) = exact_slug {
                        let nid = NoteId::parse(&nid_raw).map_err(|_| {
                            internal_not_committed("corrupt_note_id", "invalid note_id")
                        })?;
                        if is_note_live_readable_tx(tx, &space_rec.space, &auth, &nid).await? {
                            return Ok(Some(NoteRef {
                                space_id: scope.space_id,
                                note_id: nid,
                            }));
                        }
                        return Ok(None);
                    }
                }

                // 2. Exact active sibling by title_fold in `parent_id`.
                if !title_norm.is_empty() {
                    let exact_title: Vec<String> = match tx {
                        BackendConn::Sqlite(conn) => {
                            let rows = sqlx::query(
                                "SELECT note_id FROM note_heads
                                 WHERE space_id = ? AND parent_folder_id = ? AND title_fold = ?
                                   AND lifecycle_state = 'active'
                                 ORDER BY updated_seq DESC, note_id ASC
                                 LIMIT 16",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(parent_id.as_str())
                            .bind(&title_norm)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_resolve_note_title", err.to_string())
                            })?;
                            rows.into_iter().map(|r| r.get("note_id")).collect()
                        }
                        BackendConn::Postgres(conn) => {
                            let rows = sqlx::query(
                                "SELECT note_id FROM note_heads
                                 WHERE space_id = $1 AND parent_folder_id = $2 AND title_fold = $3
                                   AND lifecycle_state = 'active'
                                 ORDER BY updated_seq DESC, note_id ASC
                                 LIMIT 16",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(parent_id.as_str())
                            .bind(&title_norm)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                crate::runtime::pg_read_error("pg_resolve_note_title", err)
                            })?;
                            rows.into_iter().map(|r| r.get("note_id")).collect()
                        }
                    };
                    for nid_raw in exact_title {
                        let nid = NoteId::parse(&nid_raw).map_err(|_| {
                            internal_not_committed("corrupt_note_id", "invalid note_id")
                        })?;
                        if is_note_live_readable_tx(tx, &space_rec.space, &auth, &nid).await? {
                            return Ok(Some(NoteRef {
                                space_id: scope.space_id,
                                note_id: nid,
                            }));
                        }
                    }
                }

                // 3. Historical slug alias in `parent_id` (newest first).
                let mut candidates: Vec<String> = Vec::new();
                if let Some(sf) = &slug_fold_opt {
                    let slug_cands: Vec<String> = match tx {
                        BackendConn::Sqlite(conn) => {
                            let rows = sqlx::query(
                                "SELECT target_note_id FROM note_aliases
                                 WHERE space_id = ? AND old_parent_folder_id = ? AND old_slug_fold = ?
                                 ORDER BY created_seq DESC
                                 LIMIT 32",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(parent_id.as_str())
                            .bind(sf)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed(
                                    "sqlite_resolve_note_slug_alias",
                                    err.to_string(),
                                )
                            })?;
                            rows.into_iter().map(|r| r.get("target_note_id")).collect()
                        }
                        BackendConn::Postgres(conn) => {
                            let rows = sqlx::query(
                                "SELECT target_note_id FROM note_aliases
                                 WHERE space_id = $1 AND old_parent_folder_id = $2 AND old_slug_fold = $3
                                 ORDER BY created_seq DESC
                                 LIMIT 32",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(parent_id.as_str())
                            .bind(sf)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                crate::runtime::pg_read_error("pg_resolve_note_slug_alias", err)
                            })?;
                            rows.into_iter().map(|r| r.get("target_note_id")).collect()
                        }
                    };
                    candidates.extend(slug_cands);
                }

                // 4. Historical title alias across Space (newest first).
                if !title_norm.is_empty() {
                    let title_cands: Vec<String> = match tx {
                        BackendConn::Sqlite(conn) => {
                            let rows = sqlx::query(
                                "SELECT target_note_id FROM note_aliases
                                 WHERE space_id = ? AND old_title_norm = ?
                                 ORDER BY created_seq DESC
                                 LIMIT 32",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(&title_norm)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed(
                                    "sqlite_resolve_note_title_alias",
                                    err.to_string(),
                                )
                            })?;
                            rows.into_iter().map(|r| r.get("target_note_id")).collect()
                        }
                        BackendConn::Postgres(conn) => {
                            let rows = sqlx::query(
                                "SELECT target_note_id FROM note_aliases
                                 WHERE space_id = $1 AND old_title_norm = $2
                                 ORDER BY created_seq DESC
                                 LIMIT 32",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(&title_norm)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                crate::runtime::pg_read_error("pg_resolve_note_title_alias", err)
                            })?;
                            rows.into_iter().map(|r| r.get("target_note_id")).collect()
                        }
                    };
                    candidates.extend(title_cands);
                }

                let mut visited = BTreeSet::new();
                for cand_raw in candidates {
                    if !visited.insert(cand_raw.clone()) {
                        continue;
                    }
                    let nid = NoteId::parse(&cand_raw).map_err(|_| {
                        internal_not_committed("corrupt_alias_note_id", "invalid target_note_id")
                    })?;
                    if is_note_live_readable_tx(tx, &space_rec.space, &auth, &nid).await? {
                        return Ok(Some(NoteRef {
                            space_id: scope.space_id,
                            note_id: nid,
                        }));
                    }
                }
                Ok(None)
            })
        })
        .await
}

pub(crate) async fn set_folder_write_lock_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    folder: FolderId,
    locked: bool,
) -> Result<FolderRef, PortError> {
    if ctx.confirmed_chat_step().is_some() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    let deadline =
        crate::domain::common::CommandDeadline::start(&ctx.budget, "set_folder_write_lock");
    let target_write_class = folder_mutation_class(ctx.auth(), &ctx.scope().space_id)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let auth = ctx.auth().clone();
    let scope = space_rec.scope.clone();
    let folder_cl = folder.clone();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: None,
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                let folder_row = load_folder_head_row(tx, &scope.space_id, &folder_cl).await?;
                if folder_row.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let anc = load_folder_ancestry_tx(tx, &scope.space_id, &folder_cl, true).await?;
                // Unlocking checks write permission without failing on the folder's own existing lock!
                let check_facts = notarium_core::auth::ResourceFacts {
                    space: live_space.space.clone(),
                    class: target_write_class,
                    project: anc.project,
                    ancestor_folders: anc.ancestors,
                    folder_write_locked: false,
                    ability_package: None,
                };
                auth.authorize_direct_write(&check_facts, &check_facts)?;

                let lock_json: Option<&str> = if locked {
                    Some("{\"locked\":true}")
                } else {
                    None
                };
                let seq: SpaceSeq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET write_lock_json = ?, rev_seq = rev_seq + 1, head_rev_id = ?,
                                 updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                             WHERE space_id = ? AND folder_id = ?",
                        )
                        .bind(lock_json)
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(folder_cl.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_folder_lock", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET write_lock_json = $1, rev_seq = rev_seq + 1, head_rev_id = $2,
                                 updated_seq = $3, updated_at_sec = $4, updated_at_nsec = $5
                             WHERE space_id = $6 AND folder_id = $7",
                        )
                        .bind(lock_json)
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(folder_cl.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_folder_lock", err.to_string()))?;
                    }
                }

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(
                    FolderRevisionMetadata {
                        confirmation: None,
                        folder_id: folder_cl.clone(),
                        parent_folder_id: folder_row.parent_folder_id,
                        is_root: folder_row.is_root,
                        slug: folder_row.slug,
                        slug_fold: folder_row.slug_fold,
                        display_name: folder_row.display_name,
                        is_project: folder_row.is_project,
                        project_slug: folder_row.project_slug,
                        description: folder_row.description,
                        cover_note_id: folder_row.cover_note_id,
                        write_locked: locked,
                        lifecycle: Lifecycle::Active,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &new_rev,
                    "folder",
                    folder_cl.as_str(),
                    seq,
                    seq,
                    Some(&folder_row.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    None,
                    now_ts,
                )
                .await?;

                let fref = FolderRef {
                    space_id: scope.space_id.clone(),
                    folder_id: folder_cl.clone(),
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&fref)?;
                let cmd_id = new_prefixed_hex_id("cmd_")?;
                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "set_folder_write_lock".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "folder".to_owned(),
                        entity_id: folder_cl.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: None,
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let _ = active_note_sibling_exists_tx;
    deadline
        .submit_with_effect(store, &ctx.budget, intent, ctx.canonical_effect().cloned())
        .await
}

/// Memory and ability grants apply to those documents only. Neither grants authority
/// to change the containing folder or its write lock.
pub(crate) fn folder_mutation_class(
    auth: &notarium_core::auth::EngineAuthContext,
    space: &notarium_core::ids::SpaceId,
) -> Result<DocClass, DomainError> {
    let grant = auth
        .spaces()
        .get(space)
        .ok_or(DomainError::ResourceNotFound)?;
    if grant.write_classes.contains(&DocClass::UserDoc) {
        return Ok(DocClass::UserDoc);
    }
    grant
        .write_classes
        .iter()
        .copied()
        .find(|class| !matches!(class, DocClass::AgentMemory | DocClass::Skill))
        .ok_or(DomainError::SpaceReadOnly)
}

async fn is_folder_readable_tx(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    folder_id: &FolderId,
    cache: &mut FolderAncestryCache,
) -> Result<bool, PortError> {
    let Some(anc) =
        super::common::optional_read(cache.load_ancestry_tx(tx, &space.id, folder_id, true).await)?
    else {
        return Ok(false);
    };
    let Some(grant) = auth.spaces().get(&space.id) else {
        return Ok(false);
    };
    let Some(readable_class) = grant.read_classes.iter().copied().next() else {
        return Ok(false);
    };
    let facts = notarium_core::auth::ResourceFacts {
        space: space.clone(),
        class: readable_class,
        project: anc.project,
        ancestor_folders: anc.ancestors,
        folder_write_locked: anc.write_locked,
        ability_package: None,
    };
    Ok(auth.authorize_read(&facts).is_ok())
}

pub(crate) async fn is_note_live_readable_tx(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    note_id: &NoteId,
) -> Result<bool, PortError> {
    if is_note_purge_fenced_tx(tx, &space.id, note_id.as_str()).await? {
        return Ok(false);
    }
    let Some(head) = load_note_head_row_opt_tx(tx, &space.id, note_id).await? else {
        return Ok(false);
    };
    if head.lifecycle != Lifecycle::Active {
        return Ok(false);
    }
    let Some((facts, _)) = super::common::optional_read(
        build_resource_facts_tx(
            tx,
            space,
            &head.parent_folder_id,
            head.doc_class,
            head.ability_id,
            true,
        )
        .await,
    )?
    else {
        return Ok(false);
    };
    Ok(auth.authorize_read(&facts).is_ok())
}

async fn subtree_reaches_depth_tx(
    tx: &mut BackendConn<'_>,
    space_id: &notarium_core::ids::SpaceId,
    root_of_move: &FolderId,
    forbidden_depth: usize,
) -> Result<bool, PortError> {
    let depth = forbidden_depth as i64;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(include_str!("folder_subtree.sqlite.sql"))
            .bind(space_id.as_str())
            .bind(root_of_move.as_str())
            .bind(depth)
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_subtree_depth", err.to_string())),
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(include_str!("folder_subtree.postgres.sql"))
                .bind(space_id.as_str())
                .bind(root_of_move.as_str())
                .bind(depth)
                .fetch_one(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_subtree_depth", err.to_string()))
        }
    }
}
