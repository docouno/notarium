use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    classes::{AbilityKind, ClassifiedAbilityResource, DocClass},
    error::{PortError, ValidationReason},
    ids::{AbilityId, ContentDigest, RevisionId},
    model::{AbilityResourceName, AbilityResourceRef, Lifecycle, PathTarget},
    ports::{
        AbilityPackageRevision, Committed, Mutation, PublishAbilityPackage, ReadAbilityResource,
        SpaceContext,
    },
    receipt::MutationReceiptToken,
};
use notarium_syntax::unicode::validate_component;
use sqlx::Row;

use crate::{
    CanonicalStore,
    blobs::{
        BlobOwnerKind, BlobReferenceClaim, PreparedBlobSource, activate_and_bind_blob_ref_tx,
        bind_existing_active_blob_ref_tx,
    },
    changes::{ChangedNoteSummaryV1, EffectBodyV1, build_effect_payload_draft},
    codec::{
        AbilityRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload,
        ability_kind_to_db, internal_not_committed, lifecycle_from_db, new_prefixed_hex_id,
        new_revision_id, now_utc_timestamp,
    },
    domain::common::{
        StoredCommittedAbilityRevV1, build_resource_facts_tx, derive_command_identity_spec,
        load_note_head_row_tx, note_rank_version_digest, validate_mutation_identity,
    },
    runtime::{insert_revision_row, is_note_purge_fenced_tx, load_space_record},
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};

pub const ABILITY_ENTRYPOINT_KEY: &str = "SKILL.md";
pub const MAX_ABILITY_AUX_FILES: usize = 256;
pub const MAX_ABILITY_PACKAGE_RAW_BYTES: u64 = 8 * 1024 * 1024;

fn validate_ability_aux_path(rel_path: &str) -> Result<(), PortError> {
    if rel_path.is_empty()
        || rel_path.starts_with('/')
        || rel_path.ends_with('/')
        || rel_path.contains('\\')
        || rel_path.contains('\0')
    {
        return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
    }
    if rel_path.eq_ignore_ascii_case(ABILITY_ENTRYPOINT_KEY) {
        return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
    }
    for segment in rel_path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
        }
        validate_component(segment)?;
    }
    Ok(())
}

pub(crate) async fn publish_ability_package_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<PublishAbilityPackage>,
) -> Result<Committed<AbilityPackageRevision>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    // Cap::AbilityWrite + DirectHuman is strictly mandatory!
    ctx.auth().authorize_ability_mutation()?;

    if request.input.files.len() > MAX_ABILITY_AUX_FILES {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }

    let mut seen_paths = BTreeSet::new();
    let mut prepared_aux: Vec<(String, ContentDigest, PreparedBlobSource)> =
        Vec::with_capacity(request.input.files.len());
    let mut aux_raw_bytes: u64 = 0;

    for file in &request.input.files {
        validate_ability_aux_path(&file.path)?;
        if !seen_paths.insert(file.path.clone()) {
            return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
        }
        let actual_digest = notarium_syntax::content_digest(&file.content);
        if actual_digest != file.digest {
            return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
        }
        aux_raw_bytes = aux_raw_bytes.saturating_add(file.content.len() as u64);
        if aux_raw_bytes > MAX_ABILITY_PACKAGE_RAW_BYTES {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        let prep = store.prepare_blob(file.content.as_bytes())?;
        prepared_aux.push((file.path.clone(), actual_digest, prep));
    }

    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    // Stage all auxiliary CAS blobs in Phase 1 outside the writer lock.
    let mut staged_aux = Vec::with_capacity(prepared_aux.len());
    let mut total_staged_bytes: u64 = 0;
    for (path, digest, prep) in &prepared_aux {
        let ticket = store
            .stage_blob(&space_rec.scope, space_rec.active_epoch, prep)
            .await?;
        total_staged_bytes = total_staged_bytes.saturating_add(ticket.compressed_size);
        staged_aux.push((path.clone(), *digest, ticket));
    }

    let mut fp_hasher = blake3::Hasher::new();
    fp_hasher.update(request.input.ability.as_str().as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(ability_kind_to_db(request.input.kind).as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(request.input.entrypoint.as_str().as_bytes());
    fp_hasher.update(&[0]);
    if let Some(exp) = &request.input.expected_package_revision {
        fp_hasher.update(exp.as_str().as_bytes());
    }
    for (path, digest, _) in &staged_aux {
        fp_hasher.update(&[0]);
        fp_hasher.update(path.as_bytes());
        fp_hasher.update(digest.as_bytes());
    }
    let idemp = derive_command_identity_spec(
        &request.identity,
        "publish_ability_package",
        fp_hasher.finalize().as_bytes(),
    );

    let auth = ctx.auth().clone();
    let input_ability = request.input.ability.clone();
    let input_kind = request.input.kind;
    let input_entrypoint = request.input.entrypoint.clone();
    let expected_pkg_rev = request.input.expected_package_revision.clone();
    let scope = space_rec.scope.clone();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: vec![input_entrypoint.clone()],
        staged_bytes: total_staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                auth.authorize_ability_mutation()?;
                let live_space = load_space_record(tx, &scope.space_id).await?;
                let entry_head =
                    load_note_head_row_tx(tx, &scope.space_id, &input_entrypoint).await?;
                if entry_head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if entry_head.doc_class != DocClass::Skill {
                    return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
                }
                if let Some(existing_ab) = &entry_head.ability_id
                    && existing_ab != &input_ability
                {
                    return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
                }

                let entry_digest = entry_head.content_digest.ok_or_else(|| {
                    internal_not_committed(
                        "skill_entrypoint_missing_digest",
                        "active Skill note missing content_blake3",
                    )
                })?;
                let total_raw_bytes = entry_head.byte_size.saturating_add(aux_raw_bytes);
                if total_raw_bytes > MAX_ABILITY_PACKAGE_RAW_BYTES {
                    return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
                }

                let (before_facts, _) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &entry_head.parent_folder_id,
                    DocClass::Skill,
                    entry_head.ability_id.clone(),
                    true,
                )
                .await?;
                let mut after_facts = before_facts.clone();
                after_facts.ability_package = Some(input_ability.clone());
                auth.authorize_direct_write(&before_facts, &after_facts)?;

                // Check existing `ability_packages` state and expected_package_revision CAS.
                let existing_pkg =
                    load_ability_package_row_opt_tx(tx, &scope.space_id, &input_ability).await?;
                let prev_rev_opt = match &existing_pkg {
                    Some((lc, cur_rev, cur_entry)) => {
                        if *lc == Lifecycle::Purged {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        if cur_entry != &input_entrypoint {
                            return Err(
                                DomainError::validation(ValidationReason::ScopeMismatch).into()
                            );
                        }
                        if expected_pkg_rev.as_ref() != Some(cur_rev) {
                            return Err(DomainError::RevisionConflict {
                                current: cur_rev.clone(),
                                lineage: None,
                            }
                            .into());
                        }
                        Some(cur_rev.clone())
                    }
                    None => {
                        if let Some(unexpected) = &expected_pkg_rev {
                            return Err(DomainError::RevisionConflict {
                                current: unexpected.clone(),
                                lineage: None,
                            }
                            .into());
                        }
                        None
                    }
                };

                // Enforce active package slug uniqueness across the Space.
                if active_ability_slug_conflict_tx(
                    tx,
                    &scope.space_id,
                    &entry_head.slug_fold,
                    &input_ability,
                )
                .await?
                {
                    let report_parent = (entry_head.parent_folder_id != item_ctx.root_folder_id)
                        .then_some(entry_head.parent_folder_id.clone());
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope.space_id.clone(),
                            parent: report_parent,
                            component: entry_head.slug.clone(),
                        },
                    }
                    .into());
                }

                let seq = item_ctx.alloc_next_seq()?;
                let pkg_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let seq_i64 = seq.get() as i64;

                let mut manifest = BTreeMap::new();
                manifest.insert(ABILITY_ENTRYPOINT_KEY.to_owned(), entry_digest);

                // Bind entrypoint resource ref (`SKILL.md`) to this exact `pkg_rev`.
                bind_existing_active_blob_ref_tx(
                    tx,
                    &scope.space_id,
                    BlobOwnerKind::AbilityResource,
                    input_ability.as_str(),
                    pkg_rev.as_str(),
                    ABILITY_ENTRYPOINT_KEY,
                    entry_digest,
                    seq,
                )
                .await?;

                // Activate & bind all auxiliary resource refs to this exact `pkg_rev`.
                for (path, digest, ticket) in staged_aux {
                    item_ctx.record_staged_ticket(ticket.clone());
                    activate_and_bind_blob_ref_tx(
                        tx,
                        item_ctx.active_epoch,
                        &BlobReferenceClaim {
                            ticket,
                            owner_kind: BlobOwnerKind::AbilityResource,
                            owner_id: input_ability.as_str().to_owned(),
                            owner_rev_id: pkg_rev.as_str().to_owned(),
                            resource_key: path.clone(),
                        },
                        seq,
                    )
                    .await?;
                    manifest.insert(path, digest);
                }

                let manifest_hex_map: BTreeMap<String, String> = manifest
                    .iter()
                    .map(|(k, d)| (k.clone(), d.to_hex()))
                    .collect();
                let manifest_json = serde_json::to_string(&manifest_hex_map).map_err(|err| {
                    internal_not_committed("encode_ability_manifest_json", err.to_string())
                })?;

                // Attach `ability_id` onto the entrypoint note head if not yet attached.
                if entry_head.ability_id.is_none() {
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "UPDATE note_heads SET ability_id = ? WHERE space_id = ? AND note_id = ?",
                            )
                            .bind(input_ability.as_str())
                            .bind(scope.space_id.as_str())
                            .bind(input_entrypoint.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_bind_note_ability", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "UPDATE note_heads SET ability_id = $1 WHERE space_id = $2 AND note_id = $3",
                            )
                            .bind(input_ability.as_str())
                            .bind(scope.space_id.as_str())
                            .bind(input_entrypoint.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_bind_note_ability", err.to_string())
                            })?;
                        }
                    }
                }

                let kind_str = ability_kind_to_db(input_kind);
                if existing_pkg.is_some() {
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "UPDATE ability_packages
                                 SET kind = ?, slug_fold = ?, manifest_rev_id = ?,
                                     resource_manifest_json = ?, lifecycle_state = 'active', updated_seq = ?
                                 WHERE space_id = ? AND ability_id = ?",
                            )
                            .bind(kind_str)
                            .bind(&entry_head.slug_fold)
                            .bind(pkg_rev.as_str())
                            .bind(&manifest_json)
                            .bind(seq_i64)
                            .bind(scope.space_id.as_str())
                            .bind(input_ability.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_update_ability_pkg", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "UPDATE ability_packages
                                 SET kind = $1, slug_fold = $2, manifest_rev_id = $3,
                                     resource_manifest_json = $4, lifecycle_state = 'active', updated_seq = $5
                                 WHERE space_id = $6 AND ability_id = $7",
                            )
                            .bind(kind_str)
                            .bind(&entry_head.slug_fold)
                            .bind(pkg_rev.as_str())
                            .bind(&manifest_json)
                            .bind(seq_i64)
                            .bind(scope.space_id.as_str())
                            .bind(input_ability.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_update_ability_pkg", err.to_string())
                            })?;
                        }
                    }
                } else {
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "INSERT INTO ability_packages (
                                    space_id, ability_id, kind, slug_fold, entrypoint_note_id,
                                    manifest_rev_id, resource_manifest_json, lifecycle_state,
                                    created_seq, updated_seq
                                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(input_ability.as_str())
                            .bind(kind_str)
                            .bind(&entry_head.slug_fold)
                            .bind(input_entrypoint.as_str())
                            .bind(pkg_rev.as_str())
                            .bind(&manifest_json)
                            .bind(seq_i64)
                            .bind(seq_i64)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_insert_ability_pkg", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "INSERT INTO ability_packages (
                                    space_id, ability_id, kind, slug_fold, entrypoint_note_id,
                                    manifest_rev_id, resource_manifest_json, lifecycle_state,
                                    created_seq, updated_seq
                                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $8)",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(input_ability.as_str())
                            .bind(kind_str)
                            .bind(&entry_head.slug_fold)
                            .bind(input_entrypoint.as_str())
                            .bind(pkg_rev.as_str())
                            .bind(&manifest_json)
                            .bind(seq_i64)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_insert_ability_pkg", err.to_string())
                            })?;
                        }
                    }
                }

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Ability(
                    AbilityRevisionMetadata {
                        ability_id: input_ability.clone(),
                        kind: input_kind,
                        slug_fold: entry_head.slug_fold.clone(),
                        entrypoint_note_id: input_entrypoint.clone(),
                        entrypoint_revision: entry_head.head_rev_id.clone(),
                        lifecycle: Lifecycle::Active,
                        resources: manifest.clone(),
                        total_bytes: total_raw_bytes,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &pkg_rev,
                    "ability",
                    input_ability.as_str(),
                    seq,
                    seq,
                    prev_rev_opt.as_ref(),
                    None,
                    Some(entry_digest),
                    &meta,
                    auth.principal(),
                    None,
                    now_ts,
                )
                .await?;

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "publish_ability_package",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: input_entrypoint.clone(),
                            revision: entry_head.head_rev_id.clone(),
                            rank_version: note_rank_version_digest(
                                &entry_head.head_rev_id,
                                Some(pkg_rev.as_str()),
                            ),
                            lifecycle: Lifecycle::Active,
                            doc_class: DocClass::Skill,
                            changed_fields: BTreeMap::new(),
                        }],
                    },
                    vec![input_entrypoint.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedAbilityRevV1 {
                    ability: input_ability.clone(),
                    revision: pkg_rev.clone(),
                    manifest: manifest.clone(),
                    receipt: receipt.clone(),
                };
                let detail_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let sanitized_resp = StoredCommittedAbilityRevV1 {
                    ability: input_ability.clone(),
                    revision: pkg_rev.clone(),
                    manifest: BTreeMap::new(),
                    receipt,
                };
                let sanitized_bytes = CanonicalStore::encode_command_outcome(&sanitized_resp)?;
                let op_kind = if existing_pkg.is_some() {
                    "edit"
                } else {
                    "create"
                };

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "publish_ability_package".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "ability".to_owned(),
                        entity_id: input_ability.as_str().to_owned(),
                        op_kind: op_kind.to_owned(),
                        rev_id: pkg_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(DocClass::Skill),
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: Some(detail_bytes.clone()),
                    receipt_sanitized_blob: sanitized_bytes,
                    receipt_owner_note_ids: vec![input_entrypoint],
                    response_bytes: detail_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedAbilityRevV1 =
        store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(crate) async fn read_ability_resource_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ReadAbilityResource,
) -> Result<ClassifiedAbilityResource, PortError> {
    let manifest_key = match &request.resource {
        AbilityResourceName::Entrypoint => ABILITY_ENTRYPOINT_KEY,
        AbilityResourceName::Auxiliary(rel) => {
            if rel.eq_ignore_ascii_case(ABILITY_ENTRYPOINT_KEY) {
                return Err(DomainError::ResourceNotFound.into());
            }
            validate_ability_aux_path(rel)?;
            rel.as_str()
        }
    };

    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let req_ability = request.ability.clone();
    let req_pkg_rev = request.package_revision.clone();
    let key_owned = manifest_key.to_owned();

    let (entrypoint_note, facts, digest) = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope.space_id).await?;
                space_rec.scope.check(&scope)?;
                if space_rec.space.lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let Some((pkg_lc, _, entrypoint_note_id)) =
                    load_ability_package_row_opt_tx(tx, &scope.space_id, &req_ability).await?
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                if pkg_lc != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if is_note_purge_fenced_tx(tx, &scope.space_id, entrypoint_note_id.as_str()).await?
                {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let entry_head =
                    load_note_head_row_tx(tx, &scope.space_id, &entrypoint_note_id).await?;
                if entry_head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let (facts, _) = build_resource_facts_tx(
                    tx,
                    &space_rec.space,
                    &entry_head.parent_folder_id,
                    DocClass::Skill,
                    Some(req_ability.clone()),
                    true,
                )
                .await?;
                auth.authorize_read(&facts)?;

                // Strictly resolve the exact requested `package_revision`; NEVER fall back to latest!
                let meta_bytes: Option<Vec<u8>> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT metadata_msgpack FROM revisions
                         WHERE space_id = ? AND rev_id = ? AND entity_type = 'ability' AND entity_key = ?",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(req_pkg_rev.as_str())
                    .bind(req_ability.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_read_ability_rev", err.to_string())
                    })?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT metadata_msgpack FROM revisions
                         WHERE space_id = $1 AND rev_id = $2 AND entity_type = 'ability' AND entity_key = $3",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(req_pkg_rev.as_str())
                    .bind(req_ability.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_read_ability_rev", err.to_string())
                    })?,
                };

                let Some(raw_meta) = meta_bytes else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                let env = RevisionMetadataEnvelope::decode(&raw_meta)?;
                let RevisionMetadataPayload::Ability(ab_meta) = env.payload else {
                    return Err(internal_not_committed(
                        "corrupt_ability_rev_payload",
                        "expected Ability metadata payload",
                    ));
                };
                if ab_meta.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let Some(digest) = ab_meta.resources.get(&key_owned).copied() else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                Ok((entrypoint_note_id, facts, digest))
            })
        })
        .await?;

    // Load verified CAS bytes outside SQL read transaction, then re-check live purge fence!
    let raw_bytes = store.read_verified_blob(ctx.scope(), digest).await?;
    let content = String::from_utf8(raw_bytes).map_err(|_| {
        internal_not_committed(
            "ability_resource_utf8",
            "ability resource is not valid UTF-8",
        )
    })?;

    let scope_recheck = ctx.scope().clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                if is_note_purge_fenced_tx(tx, &scope_recheck.space_id, entrypoint_note.as_str())
                    .await?
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Ok(())
            })
        })
        .await?;

    let _ = AbilityKind::Skill;
    ClassifiedAbilityResource::from_canonical(
        AbilityResourceRef {
            space: ctx.scope().space_id.clone(),
            ability: request.ability,
            package_revision: request.package_revision,
            resource: request.resource,
        },
        facts,
        Lifecycle::Active,
        content,
        digest,
    )
    .map_err(PortError::from)
}

async fn load_ability_package_row_opt_tx(
    tx: &mut BackendConn<'_>,
    space_id: &notarium_core::ids::SpaceId,
    ability_id: &AbilityId,
) -> Result<Option<(Lifecycle, RevisionId, notarium_core::ids::NoteId)>, PortError> {
    let raw: Option<(String, String, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT lifecycle_state, manifest_rev_id, entrypoint_note_id
                 FROM ability_packages WHERE space_id = ? AND ability_id = ?",
            )
            .bind(space_id.as_str())
            .bind(ability_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_ability_pkg", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("lifecycle_state"),
                    r.get("manifest_rev_id"),
                    r.get("entrypoint_note_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT lifecycle_state, manifest_rev_id, entrypoint_note_id
                 FROM ability_packages WHERE space_id = $1 AND ability_id = $2",
            )
            .bind(space_id.as_str())
            .bind(ability_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_ability_pkg", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("lifecycle_state"),
                    r.get("manifest_rev_id"),
                    r.get("entrypoint_note_id"),
                )
            })
        }
    };
    let Some((lc_str, rev_str, note_str)) = raw else {
        return Ok(None);
    };
    let lc = lifecycle_from_db(&lc_str)?;
    let rev = RevisionId::parse(&rev_str)
        .map_err(|_| internal_not_committed("corrupt_pkg_rev", "invalid manifest_rev_id"))?;
    let note = notarium_core::ids::NoteId::parse(&note_str)
        .map_err(|_| internal_not_committed("corrupt_pkg_entry", "invalid entrypoint_note_id"))?;
    Ok(Some((lc, rev, note)))
}

async fn active_ability_slug_conflict_tx(
    tx: &mut BackendConn<'_>,
    space_id: &notarium_core::ids::SpaceId,
    slug_fold: &str,
    exclude_ability: &AbilityId,
) -> Result<bool, PortError> {
    let found: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM ability_packages
             WHERE space_id = ? AND slug_fold = ? AND lifecycle_state = 'active' AND ability_id <> ?
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(slug_fold)
        .bind(exclude_ability.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_ability_slug_check", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM ability_packages
             WHERE space_id = $1 AND slug_fold = $2 AND lifecycle_state = 'active' AND ability_id <> $3
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(slug_fold)
        .bind(exclude_ability.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_ability_slug_check", err.to_string()))?,
    };
    Ok(found.is_some())
}
