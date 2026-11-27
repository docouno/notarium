use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    DomainError,
    auth::SpaceKind,
    classes::{AbilityKind, ClassifiedAbilityResource, DocClass},
    error::{PortError, ValidationReason},
    ids::{AbilityId, ContentDigest, RevisionId},
    model::{
        AbilityResourceName, AbilityResourceRef, FolderRef, HistoryScope, Lifecycle, PathTarget,
    },
    ports::{
        AbilityPackageRevision, AbilityPlacement, AbilityRef, Committed, Mutation,
        PublishAbilityPackage, ReadAbilityResource, SpaceContext, TrashAbilityPackage,
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
        FolderAncestryCache, NoteHeadRow, StoredCommittedAbilityRevV1, build_resource_facts_tx,
        derive_command_identity_spec, load_note_head_row_tx, note_rank_version_digest,
        validate_mutation_identity,
    },
    runtime::{insert_revision_row, load_space_record},
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};

pub const ABILITY_ENTRYPOINT_KEY: &str = "SKILL.md";
pub use notarium_core::ports::MAX_ABILITY_AUX_FILES;
pub const MAX_ABILITY_PACKAGE_RAW_BYTES: u64 = 8 * 1024 * 1024;

fn validate_ability_aux_path(rel_path: &str) -> Result<(), PortError> {
    if rel_path.len() > notarium_core::ports::MAX_ABILITY_AUX_PATH_BYTES
        || rel_path.is_empty()
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

#[derive(Clone, Copy)]
struct PublicationExpectation<'a> {
    package: Option<&'a RevisionId>,
    entrypoint: Option<&'a RevisionId>,
}
struct AuthorizedEntrypoint {
    space: crate::SpaceRecord,
    head: NoteHeadRow,
    project: Option<notarium_core::ids::FolderId>,
}

struct PublicationCheck {
    entrypoint: AuthorizedEntrypoint,
    digest: ContentDigest,
    previous: Option<RevisionId>,
}

async fn authorize_entrypoint_tx(
    tx: &mut BackendConn<'_>,
    scope: &notarium_core::model::HistoryScope,
    auth: &notarium_core::auth::EngineAuthContext,
    entrypoint: &notarium_core::ids::NoteId,
    ability: &AbilityId,
    require_active_folders: bool,
) -> Result<AuthorizedEntrypoint, PortError> {
    auth.authorize_ability_mutation()?;
    let live_space = load_space_record(tx, &scope.space_id).await?;
    live_space.scope.check(scope)?;
    let head = load_note_head_row_tx(tx, &scope.space_id, entrypoint).await?;
    let (before, ancestry) = build_resource_facts_tx(
        tx,
        &live_space.space,
        &head.parent_folder_id,
        head.doc_class,
        head.ability_id.clone(),
        require_active_folders,
    )
    .await?;
    if ancestry.folder_lifecycle == Lifecycle::Purged {
        return Err(DomainError::ResourceNotFound.into());
    }
    let mut after = before.clone();
    after.ability_package = Some(ability.clone());
    auth.authorize_direct_write(&before, &after)?;
    Ok(AuthorizedEntrypoint {
        space: live_space,
        head,
        project: ancestry.project,
    })
}

async fn check_package_publication_tx(
    tx: &mut BackendConn<'_>,
    scope: &notarium_core::model::HistoryScope,
    auth: &notarium_core::auth::EngineAuthContext,
    entrypoint: &notarium_core::ids::NoteId,
    ability: &AbilityId,
    expected: PublicationExpectation<'_>,
    aux_raw_bytes: u64,
) -> Result<PublicationCheck, PortError> {
    let entrypoint_facts =
        authorize_entrypoint_tx(tx, scope, auth, entrypoint, ability, true).await?;
    let entry_head = &entrypoint_facts.head;
    let live_space = &entrypoint_facts.space;

    if entry_head.lifecycle != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    if entry_head.doc_class != DocClass::Skill {
        return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
    }
    if let Some(existing_ab) = &entry_head.ability_id
        && existing_ab != ability
    {
        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
    }
    if let Some(expected) = expected.entrypoint
        && expected != &entry_head.head_rev_id
    {
        return Err(DomainError::RevisionConflict {
            current: entry_head.head_rev_id.clone(),
            lineage: None,
        }
        .into());
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

    // Check existing `ability_packages` state and expected_package_revision CAS.
    let existing_pkg = load_ability_package_row_opt_tx(tx, &scope.space_id, ability).await?;
    let prev_rev_opt = match &existing_pkg {
        Some((lc, cur_rev, cur_entry)) => {
            if *lc == Lifecycle::Purged {
                return Err(DomainError::ResourceNotFound.into());
            }
            if cur_entry != entrypoint {
                super::common::authorized_collision_revision_tx(
                    tx,
                    &live_space.space,
                    auth,
                    cur_entry,
                )
                .await?
                .ok_or(DomainError::ResourceNotFound)?;

                return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
            }
            if expected.package != Some(cur_rev) {
                return Err(DomainError::RevisionConflict {
                    current: cur_rev.clone(),
                    lineage: None,
                }
                .into());
            }
            Some(cur_rev.clone())
        }
        None => {
            if let Some(unexpected) = expected.package {
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
        ability,
        entrypoint_facts.project.as_ref(),
    )
    .await?
    {
        let report_parent = (entry_head.parent_folder_id != live_space.root_folder_id)
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

    Ok(PublicationCheck {
        entrypoint: entrypoint_facts,
        digest: entry_digest,
        previous: prev_rev_opt,
    })
}

/// The old immutable publication establishes the origin of a Project → Space
/// promotion. The marker survives intermediate republishes at the destination.
async fn publication_policy(
    tx: &mut BackendConn<'_>,
    space: &crate::SpaceRecord,
    ability: &AbilityId,
    current_project: Option<&notarium_core::ids::FolderId>,
    previous: Option<&RevisionId>,
    requested_binding: bool,
) -> Result<(Option<AbilityRef>, bool), PortError> {
    let Some(previous) = previous else {
        return Ok((None, requested_binding));
    };
    let (manifest, cutoff) =
        crate::catalog::ability_manifest_tx(tx, &space.scope, ability, previous).await?;
    let binding_required = requested_binding || manifest.requires_explicit_binding;
    if space.space.kind != SpaceKind::Shared || current_project.is_some() {
        return Ok((None, binding_required));
    }
    if manifest.promoted_from.is_some() {
        return Ok((manifest.promoted_from, binding_required));
    }
    let entry = crate::runtime::read_immutable_revision_tx(
        tx,
        &space.scope,
        "note",
        manifest.entrypoint_note_id.as_str(),
        cutoff,
    )
    .await?
    .ok_or(DomainError::ResourceNotFound)?;
    let RevisionMetadataPayload::Note(note) = entry.metadata.payload else {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    };
    if entry.revision_id != manifest.entrypoint_revision {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    let (_, ancestry) = FolderAncestryCache::at_cut(&space.scope, cutoff)
        .build_resource_facts_tx(
            tx,
            &space.space,
            &note.parent_folder_id,
            note.doc_class,
            Some(ability.clone()),
            true,
        )
        .await?;
    Ok((
        ancestry.project.map(|folder_id| AbilityRef {
            id: ability.clone(),
            placement: AbilityPlacement::OwnedProject(FolderRef {
                space_id: space.space.id.clone(),
                folder_id,
            }),
            revision: previous.clone(),
        }),
        binding_required,
    ))
}

pub(super) async fn check_package_trash_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    request: &TrashAbilityPackage,
) -> Result<(), PortError> {
    let (lifecycle, current, entrypoint) =
        load_ability_package_row_opt_tx(tx, &scope.space_id, &request.ability)
            .await?
            .ok_or(DomainError::ResourceNotFound)?;
    if lifecycle != Lifecycle::Active || entrypoint != request.entrypoint {
        return Err(DomainError::ResourceNotFound.into());
    }
    if current != request.package_revision {
        return Err(DomainError::RevisionConflict {
            current,
            lineage: None,
        }
        .into());
    }
    let (manifest, _) =
        crate::catalog::ability_manifest_tx(tx, scope, &request.ability, &current).await?;
    if manifest.resources.len() != 1 || !manifest.resources.contains_key(ABILITY_ENTRYPOINT_KEY) {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(())
}

pub(crate) async fn publish_ability_package_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<PublishAbilityPackage>,
) -> Result<Committed<AbilityPackageRevision>, PortError> {
    let deadline =
        crate::domain::common::CommandDeadline::start(&ctx.budget, "publish_ability_package");
    validate_mutation_identity(&ctx, &request.identity)?;
    ctx.auth().authorize_ability_mutation()?;
    crate::domain::common::require_empty_preconditions(&request.preconditions)?;

    if request.input.files.len() > MAX_ABILITY_AUX_FILES {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
    let attached_skills = request.input.attached_skills;
    if attached_skills.len() > notarium_core::ports::MAX_ATTACHED_SKILLS
        || request.input.kind == AbilityKind::Skill && !attached_skills.is_empty()
    {
        return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
    }
    for (index, skill) in attached_skills.iter().enumerate() {
        if request.input.ability == skill.id
            || attached_skills[..index]
                .iter()
                .any(|other| other.identity() == skill.identity())
        {
            return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
        }
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

    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

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
    for (path, digest, _) in &prepared_aux {
        fp_hasher.update(&[0]);
        fp_hasher.update(path.as_bytes());
        fp_hasher.update(digest.as_bytes());
    }
    if !attached_skills.is_empty() {
        fp_hasher.update(b"\0attached-skills-v1\0");
        fp_hasher.update(&crate::codec::encode_msgpack(&attached_skills)?);
    }
    if let Some(expected) = &request.input.expected_entrypoint_revision {
        fp_hasher.update(b"\0entrypoint-revision-v1\0");
        fp_hasher.update(expected.as_str().as_bytes());
    }
    if request.input.requires_explicit_binding {
        fp_hasher.update(b"\0require-explicit-binding-v1\0");
    }
    let idemp = derive_command_identity_spec(
        &ctx,
        &request.identity,
        "publish_ability_package",
        fp_hasher.finalize().as_bytes(),
    )
    .for_note(ctx.auth(), &request.input.entrypoint);

    let auth = ctx.auth().clone();
    let input_ability = request.input.ability.clone();
    let input_kind = request.input.kind;
    let input_entrypoint = request.input.entrypoint.clone();
    let expected_pkg_rev = request.input.expected_package_revision.clone();
    let expected_entry_rev = request.input.expected_entrypoint_revision.clone();
    let requested_binding = request.input.requires_explicit_binding;
    let scope = space_rec.scope.clone();

    let preflight_scope = scope.clone();
    let preflight_auth = auth.clone();
    let entrypoint = input_entrypoint.clone();
    let ability = input_ability.clone();
    let expected = expected_pkg_rev.clone();
    let expected_entrypoint = expected_entry_rev.clone();
    let replay_key = idemp.clone();
    let preflight = || {
        store.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                if let Some(receipt) =
                    crate::writer::lookup_command_receipt_tx(tx, &preflight_scope, &replay_key)
                        .await?
                {
                    authorize_entrypoint_tx(
                        tx,
                        &preflight_scope,
                        &preflight_auth,
                        &entrypoint,
                        &ability,
                        false,
                    )
                    .await?;
                    if receipt.command_hash != replay_key.command_hash {
                        return Err(DomainError::IdempotencyKeyReused.into());
                    }
                    return Ok(Some(receipt.response_blob));
                }
                check_package_publication_tx(
                    tx,
                    &preflight_scope,
                    &preflight_auth,
                    &entrypoint,
                    &ability,
                    PublicationExpectation {
                        package: expected.as_ref(),
                        entrypoint: expected_entrypoint.as_ref(),
                    },
                    aux_raw_bytes,
                )
                .await?;
                Ok(None)
            })
        })
    };
    let replayed = deadline.prepare(&ctx.budget, preflight).await?;
    if let Some(bytes) = replayed {
        store
            .inner
            .check_writer_epoch(&scope.space_id, space_rec.active_epoch)?;
        let committed: StoredCommittedAbilityRevV1 = rmp_serde::from_slice(&bytes)
            .map_err(|err| internal_not_committed("decode_replayed_package", err.to_string()))?;
        return Ok(committed.into_committed());
    }

    // Stage all auxiliary CAS blobs in Phase 1 outside the writer lock in canonical sorted
    // deduplicated ContentDigest order so LocalSharedGuard acquisition cannot self-deadlock.
    let aux_refs: Vec<&PreparedBlobSource> = prepared_aux.iter().map(|(_, _, prep)| prep).collect();
    let staged_by_digest = deadline
        .prepare(&ctx.budget, || {
            store.stage_blobs_for_batch_sorted(&space_rec.scope, space_rec.active_epoch, &aux_refs)
        })
        .await?;
    let mut staged_aux = Vec::with_capacity(prepared_aux.len());
    let mut total_staged_bytes: u64 = 0;
    for (path, digest, _) in &prepared_aux {
        let ticket = staged_by_digest
            .get(digest)
            .cloned()
            .ok_or_else(|| internal_not_committed("missing_staged_aux_blob", "ticket missing"))?;
        total_staged_bytes = total_staged_bytes.saturating_add(ticket.compressed_size);
        staged_aux.push((path.clone(), *digest, ticket));
    }

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: vec![input_entrypoint.clone()],
        staged_bytes: total_staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let checked = check_package_publication_tx(
                    tx,
                    &scope,
                    &auth,
                    &input_entrypoint,
                    &input_ability,
                    PublicationExpectation {
                        package: expected_pkg_rev.as_ref(),
                        entrypoint: expected_entry_rev.as_ref(),
                    },
                    aux_raw_bytes,
                )
                .await?;
                let (promoted_from, requires_explicit_binding) = publication_policy(
                    tx,
                    &checked.entrypoint.space,
                    &input_ability,
                    checked.entrypoint.project.as_ref(),
                    checked.previous.as_ref(),
                    requested_binding,
                )
                .await?;
                let entry_head = checked.entrypoint.head;
                let entry_digest = checked.digest;
                let prev_rev_opt = checked.previous;
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
                        &item_ctx.scope,
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
                if prev_rev_opt.is_some() {
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

                let description = crate::runtime::read_immutable_revision_tx(
                    tx,
                    &scope,
                    "note",
                    input_entrypoint.as_str(),
                    entry_head.updated_seq,
                )
                .await?
                .and_then(|entry| match entry.metadata.payload {
                    RevisionMetadataPayload::Note(note) => note.raw_fields,
                    _ => None,
                })
                .map(|fields| match fields.get("description") {
                    Some(notarium_core::value::YamlValue::String(text)) => {
                        text.trim().chars().take(4096).collect()
                    }
                    _ => String::new(),
                })
                .or_else(|| Some(String::new()));

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Ability(
                    AbilityRevisionMetadata {
                        ability_id: input_ability.clone(),
                        kind: input_kind,
                        slug_fold: entry_head.slug_fold.clone(),
                        entrypoint_note_id: input_entrypoint.clone(),
                        entrypoint_revision: entry_head.head_rev_id.clone(),
                        lifecycle: Lifecycle::Active,
                        resources: manifest.clone(),
                        total_bytes: entry_head.byte_size.saturating_add(aux_raw_bytes),
                        attached_skills,
                        description,
                        promoted_from,
                        requires_explicit_binding,
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
                let op_kind = if prev_rev_opt.is_some() {
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

    let stored: StoredCommittedAbilityRevV1 = deadline.submit(store, &ctx.budget, intent).await?;
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

    let budget = &ctx.budget;
    let lookup = || {
        let ctx = ctx.clone();
        let request = request.clone();
        let key = manifest_key.to_owned();
        store.with_read_tx_budget(Some(budget), move |tx| {
            Box::pin(
                async move { crate::catalog::resource_digest_tx(tx, &ctx, &request, &key).await },
            )
        })
    };
    let (digest, _) = lookup().await?;
    let raw_bytes = store.read_verified_blob(ctx.scope(), digest).await?;
    let content = String::from_utf8(raw_bytes)
        .map_err(|err| internal_not_committed("ability_resource_utf8", err.to_string()))?;

    let (checked_digest, provenance) = lookup().await?;
    if checked_digest != digest {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }
    ClassifiedAbilityResource::from_canonical(
        AbilityResourceRef {
            space: ctx.scope().space_id.clone(),
            ability: request.ability,
            package_revision: request.package_revision,
            resource: request.resource,
        },
        provenance,
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
            .map_err(|err| crate::runtime::pg_read_error("pg_load_ability_pkg", err))?;
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

pub(crate) async fn active_ability_slug_conflict_tx(
    tx: &mut BackendConn<'_>,
    space_id: &notarium_core::ids::SpaceId,
    slug_fold: &str,
    exclude_ability: &AbilityId,
    project: Option<&notarium_core::ids::FolderId>,
) -> Result<bool, PortError> {
    let sql = include_str!("ability_slot_check.sql");
    let project = project.map_or("", notarium_core::ids::FolderId::as_str);
    let found: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(sql)
            .bind(space_id.as_str())
            .bind(slug_fold)
            .bind(exclude_ability.as_str())
            .bind(project)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_ability_slug_check", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(sql)
            .bind(space_id.as_str())
            .bind(slug_fold)
            .bind(exclude_ability.as_str())
            .bind(project)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_ability_slug_check", err))?,
    };
    Ok(found.is_some())
}

pub(super) async fn check_restored_ability_slot_tx(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::ids::SpaceId,
    ability: &AbilityId,
    slug: &str,
    project: Option<&notarium_core::ids::FolderId>,
) -> Result<(), PortError> {
    if active_ability_slug_conflict_tx(tx, space, slug, ability, project).await? {
        return Err(DomainError::PathConflict {
            target: PathTarget {
                space_id: space.clone(),
                parent: project.cloned(),
                component: slug.to_owned(),
            },
        }
        .into());
    }
    Ok(())
}
