use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::FolderId,
    model::{FolderRef, Lifecycle, PathTarget},
    ports::{CommandSeqRange, SpaceContext},
    receipt::{CommandIdentity, MutationReceiptToken},
};
use notarium_syntax::unicode::{PortableFilename, lookup_key};

use super::{
    VaultBinding,
    storage::{observation_changed, require_binding_for_actor_tx, require_binding_tx},
};
use crate::{
    CanonicalStore, SpaceRecord,
    changes::{EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft},
    codec::{
        FolderRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload,
        encode_timestamp_parts, internal_not_committed, new_prefixed_hex_id, new_revision_id,
        normalize_slug_key, now_utc_timestamp,
    },
    domain::{
        common::{
            CommandDeadline, MAX_FOLDER_DEPTH, StoredCommittedFolderRefV1,
            active_note_sibling_exists_tx, build_resource_facts_tx, derive_command_identity_spec,
            validate_mutation_identity,
        },
        folders::folder_mutation_class,
    },
    runtime::{
        folder_exists_in_space, insert_revision_row, load_folder_head_row, load_space_record,
    },
    sql_exec::BackendConn,
    writer::{
        BatchEventDraft, CommandIdentitySpec, ItemCommitArtifacts, PreparedWriteIntent,
        lookup_command_receipt_tx, replay::ReplayPolicy,
    },
};

#[derive(Clone, Debug)]
struct VaultFolder {
    parent: FolderId,
    slug: String,
    folded: String,
    candidate: FolderId,
}

#[derive(Clone, Debug)]
pub(crate) struct VaultFolderReplay {
    binding: VaultBinding,
    folder: VaultFolder,
}

impl VaultFolderReplay {
    pub(crate) async fn authorize(
        &self,
        tx: &mut BackendConn<'_>,
        space: &SpaceRecord,
        auth: &EngineAuthContext,
    ) -> Result<(), PortError> {
        require_binding_for_actor_tx(tx, auth, space, &self.binding).await?;
        let class = folder_mutation_class(auth, &space.scope.space_id)?;
        self.folder.authorize(tx, auth, space, class).await?;
        let row =
            match load_folder_head_row(tx, &space.scope.space_id, &self.folder.candidate).await {
                Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                    return Err(observation_changed());
                }
                result => result?,
            };
        if row.lifecycle != Lifecycle::Active
            || row.parent_folder_id.as_ref() != Some(&self.folder.parent)
            || row.slug_fold != self.folder.folded
        {
            return Err(observation_changed());
        }
        let (facts, _) =
            build_resource_facts_tx(tx, &space.space, &self.folder.candidate, class, None, true)
                .await?;
        auth.authorize_direct_write(&facts, &facts)?;
        Ok(())
    }
}

impl VaultFolder {
    fn conflict(&self, space: &SpaceRecord) -> PortError {
        DomainError::PathConflict {
            target: PathTarget {
                space_id: space.scope.space_id.clone(),
                parent: Some(self.parent.clone()),
                component: self.slug.clone(),
            },
        }
        .into()
    }

    async fn authorize(
        &self,
        tx: &mut BackendConn<'_>,
        auth: &EngineAuthContext,
        space: &SpaceRecord,
        class: DocClass,
    ) -> Result<(), PortError> {
        let (facts, ancestors) =
            build_resource_facts_tx(tx, &space.space, &self.parent, class, None, true).await?;
        auth.authorize_direct_write(&facts, &facts)?;
        if ancestors.ancestors.len() > MAX_FOLDER_DEPTH {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        Ok(())
    }

    async fn existing(
        &self,
        tx: &mut BackendConn<'_>,
        ctx: &SpaceContext,
        space: &SpaceRecord,
        class: DocClass,
    ) -> Result<Option<FolderId>, PortError> {
        let row: Option<String> = query!(
            tx,
            query_scalar,
            "SELECT folder_id FROM folder_heads
             WHERE space_id = $1 AND parent_folder_id = $2 AND slug_fold = $3
               AND lifecycle_state = 'active'",
            fetch_optional,
            space.scope.space_id.as_str(),
            self.parent.as_str(),
            &self.folded
        )?;
        if let Some(folder) = row {
            let id = FolderId::parse(&folder)?;
            let (facts, _) =
                build_resource_facts_tx(tx, &space.space, &id, class, None, true).await?;
            ctx.auth().authorize_direct_write(&facts, &facts)?;
            return Ok(Some(id));
        }
        if active_note_sibling_exists_tx(
            tx,
            &space.scope.space_id,
            &self.parent,
            &self.folded,
            None,
        )
        .await?
        {
            return Err(self.conflict(space));
        }
        Ok(None)
    }
}

impl CanonicalStore {
    /// Resolves or creates an ordinary path component with live user authority.
    /// Replays use the same command key and reauthorize both parent and result.
    pub async fn resolve_vault_folder(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        parent: Option<FolderId>,
        name: &str,
        candidate: FolderId,
        identity: CommandIdentity,
    ) -> Result<FolderId, PortError> {
        validate_mutation_identity(&ctx, &identity)?;
        PortableFilename::parse(name)?;
        let key = lookup_key(name);
        if matches!(key.as_str(), ".notarium" | ".git") || key.starts_with(".notarium-") {
            return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
        }
        let deadline = CommandDeadline::start(&ctx.budget, "resolve_vault_folder");
        let space = deadline
            .prepare(&ctx.budget, || {
                self.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
            })
            .await?;
        let class = folder_mutation_class(ctx.auth(), &space.scope.space_id)?;
        let folder = VaultFolder {
            parent: parent.unwrap_or_else(|| space.root_folder_id.clone()),
            slug: name.to_owned(),
            folded: normalize_slug_key(name)?,
            candidate,
        };
        let fingerprint = Self::encode_command_outcome(&(
            binding.generation,
            binding.root_identity,
            &folder.parent,
            &folder.slug,
            &folder.candidate,
        ))?;
        let idempotency =
            derive_command_identity_spec(&identity, "resolve_vault_folder", &fingerprint)
                .with_policy(
                    ctx.auth(),
                    ReplayPolicy::VaultFolder(VaultFolderReplay {
                        binding: binding.clone(),
                        folder: folder.clone(),
                    }),
                );

        if let Some(existing) = deadline
            .prepare(&ctx.budget, || {
                self.lookup_vault_folder(&ctx, binding, &folder, class, &idempotency)
            })
            .await?
        {
            return Ok(existing);
        }

        let intent = PreparedWriteIntent {
            scope: space.scope.clone(),
            active_epoch: space.active_epoch,
            idempotency: Some(idempotency.clone()),
            source_note_ids: Vec::new(),
            staged_bytes: 0,
            required_semantic_cut: None,
            execute: Box::new({
                let ctx = ctx.clone();
                let binding = binding.clone();
                let folder = folder.clone();
                move |tx, item| {
                    Box::pin(async move {
                        let space = load_space_record(tx, &ctx.scope().space_id).await?;
                        require_binding_tx(tx, &ctx, &space, &binding).await?;
                        folder.authorize(tx, ctx.auth(), &space, class).await?;
                        let existing = folder.existing(tx, &ctx, &space, class).await?;
                        if existing.as_ref() != Some(&folder.candidate)
                            && folder_exists_in_space(tx, &space.scope.space_id, &folder.candidate)
                                .await?
                        {
                            return Err(observation_changed());
                        }
                        if existing.is_some() {
                            return Err(folder.conflict(&space));
                        }
                        let seq = item.alloc_next_seq()?;
                        let revision = new_revision_id()?;
                        let now = now_utc_timestamp()?;
                        let (seconds, nanos) = encode_timestamp_parts(now);
                        let metadata = RevisionMetadataEnvelope::v1(
                            RevisionMetadataPayload::Folder(FolderRevisionMetadata {
                                folder_id: folder.candidate.clone(),
                                parent_folder_id: Some(folder.parent.clone()),
                                is_root: false,
                                slug: folder.slug.clone(),
                                slug_fold: folder.folded.clone(),
                                display_name: folder.slug.clone(),
                                is_project: false,
                                project_slug: None,
                                description: None,
                                cover_note_id: None,
                                write_locked: false,
                                lifecycle: Lifecycle::Active,
                            }),
                        )
                        .encode()?;
                        execute!(
                            tx,
                            "INSERT INTO folder_heads (
                            space_id, folder_id, parent_folder_id, is_root, slug, slug_fold,
                            display_name, is_project, lifecycle_state, rev_seq, head_rev_id,
                            created_seq, updated_seq, updated_at_sec, updated_at_nsec
                         ) VALUES ($1, $2, $3, 0, $4, $5, $4, 0, 'active', $6, $7, $6, $6, $8, $9)",
                            space.scope.space_id.as_str(),
                            folder.candidate.as_str(),
                            folder.parent.as_str(),
                            &folder.slug,
                            &folder.folded,
                            seq.get() as i64,
                            revision.as_str(),
                            seconds,
                            nanos
                        )?;
                        insert_revision_row(
                            tx,
                            &space.scope,
                            &revision,
                            "folder",
                            folder.candidate.as_str(),
                            seq,
                            seq,
                            None,
                            None,
                            None,
                            &metadata,
                            ctx.auth().principal(),
                            None,
                            now,
                        )
                        .await?;
                        let command_id = new_prefixed_hex_id("cmd_")?;
                        let command_kind = "create_folder";
                        let effect = build_effect_payload_draft(
                            format!("eff:{command_id}"),
                            space.scope.clone(),
                            CommandSeqRange::new(seq, seq)?,
                            command_kind,
                            EffectBodyV1::AwaitProjection {
                                reason: StoredAwaitReasonV1::Structural,
                            },
                            Vec::new(),
                        )?;
                        let outcome = StoredCommittedFolderRefV1 {
                            value: FolderRef {
                                space_id: space.scope.space_id.clone(),
                                folder_id: folder.candidate.clone(),
                            },
                            receipt: MutationReceiptToken::new(space.scope, seq)?,
                        };
                        let response = CanonicalStore::encode_command_outcome(&outcome)?;
                        Ok(ItemCommitArtifacts {
                            command_id,
                            command_kind: command_kind.to_owned(),
                            events: vec![BatchEventDraft {
                                space_seq: seq,
                                entity_type: "folder".to_owned(),
                                entity_id: folder.candidate.as_str().to_owned(),
                                op_kind: "create".to_owned(),
                                rev_id: revision,
                                lifecycle: Lifecycle::Active,
                                doc_class: None,
                            }],
                            change_payload: Some(effect),
                            receipt_detail_blob: None,
                            receipt_sanitized_blob: response.clone(),
                            receipt_owner_note_ids: Vec::new(),
                            response_bytes: response,
                        })
                    })
                }
            }),
        };

        match deadline
            .submit::<StoredCommittedFolderRefV1>(self, &ctx.budget, intent)
            .await
        {
            Ok(result) => Ok(result.value.folder_id),
            Err(PortError::Domain(DomainError::PathConflict { .. })) => {
                // Another writer can create the folder after the initial lookup.
                // Resolve the winner under fresh parent/child permissions.
                deadline
                    .prepare(&ctx.budget, || {
                        self.lookup_vault_folder(&ctx, binding, &folder, class, &idempotency)
                    })
                    .await?
                    .ok_or_else(|| folder.conflict(&space))
            }
            Err(error) => Err(error),
        }
    }

    async fn lookup_vault_folder(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
        folder: &VaultFolder,
        class: DocClass,
        idempotency: &CommandIdentitySpec,
    ) -> Result<Option<FolderId>, PortError> {
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            let ctx = ctx.clone();
            let binding = binding.clone();
            let folder = folder.clone();
            let idempotency = idempotency.clone();
            Box::pin(async move {
                let space = load_space_record(tx, &ctx.scope().space_id).await?;
                require_binding_tx(tx, &ctx, &space, &binding).await?;
                folder.authorize(tx, ctx.auth(), &space, class).await?;
                if let Some(receipt) =
                    lookup_command_receipt_tx(tx, &space.scope, &idempotency).await?
                {
                    if receipt.command_hash != idempotency.command_hash {
                        return Err(DomainError::IdempotencyKeyReused.into());
                    }
                    let stored: StoredCommittedFolderRefV1 =
                        rmp_serde::from_slice(&receipt.response_blob).map_err(|err| {
                            internal_not_committed("vault_folder_receipt", err.to_string())
                        })?;
                    return Ok(Some(stored.value.folder_id));
                }
                let existing = folder.existing(tx, &ctx, &space, class).await?;
                if existing.as_ref() != Some(&folder.candidate)
                    && folder_exists_in_space(tx, &space.scope.space_id, &folder.candidate).await?
                {
                    return Err(observation_changed());
                }
                Ok(existing)
            })
        })
        .await
    }
}
