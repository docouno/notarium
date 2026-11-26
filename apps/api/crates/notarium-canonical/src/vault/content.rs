use std::{sync::Arc, time::Duration};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, NoteId},
    model::Lifecycle,
    ports::{
        Committed, DeleteDisposition, DeleteNote, ExternalObservation, ExternalObservationResult,
        MoveNote, Mutation, NoteRevision, SpaceContext,
    },
};
use notarium_syntax::unicode::{PortableFilename, lookup_key};
use serde::Serialize;

use super::{
    VaultBinding, VaultFileStamp, VaultImport, VaultNote, VaultObservation, VaultPath, VaultSchema,
    storage::{
        active_binding_tx, check_actor, check_file, check_page, check_path, delete_observation_tx,
        guarded_candidate_tx, observation_changed, observation_for_key_tx, observation_for_note_tx,
        path_conflict, require_binding_tx, upsert_observation_tx,
    },
};
use crate::{
    CanonicalStore, SpaceRecord,
    codec::{
        RevisionMetadataEnvelope, RevisionMetadataPayload, i64_to_space_seq,
        internal_not_committed, unavailable_retryable,
    },
    domain::{
        common::{
            CommandDeadline, FolderAncestryCache, NoteHeadRow, StoredCommittedNoteRevV1,
            build_resource_facts_tx, load_current_space_schema_tx, load_folder_ancestry_tx,
            load_note_head_row_opt_tx, optional_read,
        },
        notes,
    },
    runtime::{is_note_purge_fenced_tx, load_space_record},
    sql_exec::BackendConn,
    writer::{CommandIdentitySpec, PreparedWriteIntent},
};

fn is_vault_note(class: DocClass) -> bool {
    matches!(class, DocClass::UserDoc | DocClass::EncryptedNote)
}

#[derive(Eq, PartialEq)]
struct VaultNoteMetadata {
    note: NoteRevision,
    class: DocClass,
    parent: FolderId,
    folder_path: String,
    slug: String,
    digest: ContentDigest,
}

async fn load_active_note_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<Option<(NoteHeadRow, String)>, PortError> {
    let Some(head) = load_note_head_row_opt_tx(tx, &space.scope.space_id, note).await? else {
        return Ok(None);
    };
    if !is_vault_note(head.doc_class)
        || head.lifecycle != Lifecycle::Active
        || is_note_purge_fenced_tx(tx, &space.scope.space_id, note.as_str()).await?
    {
        return Ok(None);
    }
    let Some((facts, ancestry)) = optional_read(
        build_resource_facts_tx(
            tx,
            &space.space,
            &head.parent_folder_id,
            head.doc_class,
            head.ability_id.clone(),
            true,
        )
        .await,
    )?
    else {
        return Ok(None);
    };
    if ctx.auth().authorize_read(&facts).is_err() {
        return Ok(None);
    }
    Ok(Some((head, ancestry.folder_path)))
}

async fn load_note_metadata_tx(
    tx: &mut BackendConn<'_>,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<Option<VaultNoteMetadata>, PortError> {
    let space = load_space_record(tx, &ctx.scope().space_id).await?;
    space.scope.check(ctx.scope())?;
    let Some((head, folder_path)) = load_active_note_tx(tx, &space, ctx, note).await? else {
        return Ok(None);
    };
    let digest = head.content_digest.ok_or_else(|| {
        internal_not_committed("vault_note_digest_missing", "active note lacks a carrier")
    })?;
    Ok(Some(VaultNoteMetadata {
        note: NoteRevision {
            note: note.clone(),
            revision: head.head_rev_id,
        },
        parent: head.parent_folder_id,
        class: head.doc_class,
        folder_path,
        slug: head.slug,
        digest,
    }))
}

pub(super) async fn require_vault_publication_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    ctx: &SpaceContext,
    observation: &VaultObservation,
) -> Result<(), PortError> {
    let Some((head, _)) = load_active_note_tx(tx, space, ctx, &observation.note).await? else {
        return Err(DomainError::ResourceNotFound.into());
    };
    if head.head_rev_id == observation.revision {
        if head.content_digest != Some(observation.carrier_digest) {
            return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
        }
        return Ok(());
    }

    // The checked publication can already be on disk when another canonical
    // writer commits. Keep the exact historic witness so the next feed event
    // can compare-and-swap this publication to the newer head.
    let row: Option<(Vec<u8>, Option<Vec<u8>>, i64)> = query!(
        tx,
        query_as,
        "SELECT metadata_msgpack, content_blake3, visibility_seq FROM revisions
         WHERE space_id = $1 AND history_incarnation = $2 AND rev_id = $3
           AND entity_type = 'note' AND entity_key = $4 AND visibility_seq <= $5",
        fetch_optional,
        space.scope.space_id.as_str(),
        space.scope.incarnation.as_bytes().as_slice(),
        observation.revision.as_str(),
        observation.note.as_str(),
        space.last_seq.get() as i64
    )?;
    let Some((metadata, digest, seq)) = row else {
        return Err(DomainError::ResourceNotFound.into());
    };
    let RevisionMetadataPayload::Note(previous) =
        RevisionMetadataEnvelope::decode(&metadata)?.payload
    else {
        return Err(internal_not_committed(
            "vault_revision_corrupt",
            "expected note metadata",
        ));
    };
    if previous.note_id != observation.note
        || previous.lifecycle != Lifecycle::Active
        || previous.doc_class != head.doc_class
        || previous.ability_id.is_some()
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    if previous.content_digest != Some(observation.carrier_digest)
        || digest.as_deref() != Some(observation.carrier_digest.as_bytes().as_slice())
    {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }
    let (facts, _) = FolderAncestryCache::at_cut(&space.scope, i64_to_space_seq(seq)?)
        .build_resource_facts_tx(
            tx,
            &space.space,
            &previous.parent_folder_id,
            previous.doc_class,
            None,
            true,
        )
        .await?;
    ctx.auth().authorize_read(&facts)?;
    Ok(())
}

impl CanonicalStore {
    pub async fn vault_head(
        &self,
        ctx: &SpaceContext,
    ) -> Result<notarium_core::ids::SpaceSeq, PortError> {
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let space = load_space_record(tx, &ctx.scope().space_id).await?;
                space.scope.check(ctx.scope())?;
                ctx.auth().authorize_folder_read(
                    &space.space,
                    &space.root_folder_id,
                    std::slice::from_ref(&space.root_folder_id),
                )?;
                Ok(space.last_seq)
            })
        })
        .await
    }

    /// Authorized, current-only carrier and placement for a vault publication.
    pub async fn read_vault_note(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
    ) -> Result<Option<VaultNote>, PortError> {
        self.read_vault_note_with(ctx, note, async || {}).await
    }

    #[cfg(feature = "test-support")]
    pub async fn read_vault_note_with_recheck_hook(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        before_recheck: impl AsyncFnMut(),
    ) -> Result<Option<VaultNote>, PortError> {
        self.read_vault_note_with(ctx, note, before_recheck).await
    }

    async fn read_vault_note_with(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        mut before_recheck: impl AsyncFnMut(),
    ) -> Result<Option<VaultNote>, PortError> {
        let deadline = CommandDeadline::start(&ctx.budget, "read_vault_note");
        for _ in 0..3 {
            let record = deadline
                .prepare(&ctx.budget, || {
                    self.with_read_tx_budget(Some(&ctx.budget), |tx| {
                        let ctx = ctx.clone();
                        let note = note.clone();
                        let store = self.clone();
                        Box::pin(async move {
                            let Some(metadata) = load_note_metadata_tx(tx, &ctx, &note).await?
                            else {
                                return Ok(None);
                            };
                            let read = store
                                .try_prepare_local_blob_read_in_tx(
                                    tx,
                                    &ctx.scope().space_id,
                                    metadata.digest,
                                )
                                .await?;
                            Ok(Some((metadata, read)))
                        })
                    })
                })
                .await?;
            let Some((metadata, local_read)) = record else {
                return Ok(None);
            };
            let bytes = deadline
                .prepare(&ctx.budget, || async {
                    match local_read {
                        Some(read) => read.read_verified_async().await,
                        None => self.read_verified_blob(ctx.scope(), metadata.digest).await,
                    }
                })
                .await;
            before_recheck().await;
            let current = deadline
                .prepare(&ctx.budget, || {
                    self.with_read_tx_budget(Some(&ctx.budget), |tx| {
                        let ctx = ctx.clone();
                        let note = note.clone();
                        Box::pin(async move { load_note_metadata_tx(tx, &ctx, &note).await })
                    })
                })
                .await?;
            let Some(current) = current else {
                return Ok(None);
            };
            if current != metadata {
                continue;
            }
            let carrier = String::from_utf8(bytes?).map_err(|_| {
                internal_not_committed("vault_note_utf8", "canonical carrier is not UTF-8")
            })?;
            return Ok(Some(VaultNote {
                note: metadata.note,
                class: metadata.class,
                parent: metadata.parent,
                folders: metadata
                    .folder_path
                    .split('/')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
                slug: metadata.slug,
                carrier,
                carrier_digest: metadata.digest,
            }));
        }
        Err(unavailable_retryable(
            "vault_head_contended",
            "the authorized vault note changed during each carrier read",
            Duration::from_millis(25),
        ))
    }

    /// Page the affected canonical subtree by note identity. Scope and current
    /// visibility are checked before any note identity is returned.
    pub async fn vault_note_ids_below_folder(
        &self,
        ctx: &SpaceContext,
        folder: &FolderId,
        after: Option<&NoteId>,
        limit: u16,
    ) -> Result<Vec<NoteId>, PortError> {
        let limit = check_page(limit)?;
        let after = after.map_or_else(String::new, |note| note.as_str().to_owned());
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            let ctx = ctx.clone();
            let folder = folder.clone();
            Box::pin(async move {
                let space = load_space_record(tx, &ctx.scope().space_id).await?;
                space.scope.check(ctx.scope())?;
                let mut cache = FolderAncestryCache::default();
                let ancestry = cache
                    .load_ancestry_tx(tx, &space.scope.space_id, &folder, true)
                    .await?;
                ctx.auth()
                    .authorize_folder_read(&space.space, &folder, &ancestry.ancestors)?;
                let mut after = after;
                let mut visible = Vec::new();
                while (visible.len() as i64) < limit {
                    let rows: Vec<(String, String, String)> = query!(
                        tx,
                        query_as,
                        "WITH RECURSIVE subtree(folder_id, depth) AS (
                            SELECT folder_id, 0 FROM folder_heads
                            WHERE space_id = $1 AND folder_id = $2 AND lifecycle_state = 'active'
                            UNION ALL
                            SELECT f.folder_id, s.depth + 1
                            FROM subtree s CROSS JOIN folder_heads f
                            WHERE f.space_id = $1 AND f.parent_folder_id = s.folder_id
                              AND f.lifecycle_state = 'active' AND s.depth < 256
                         )
                         SELECT n.note_id, n.parent_folder_id, n.doc_class
                         FROM subtree s CROSS JOIN note_heads n
                         WHERE n.space_id = $1 AND n.parent_folder_id = s.folder_id
                           AND n.note_id > $3 AND n.lifecycle_state = 'active'
                           AND n.doc_class IN ('user-doc', 'encrypted-note')
                         ORDER BY n.note_id LIMIT $4",
                        fetch_all,
                        space.scope.space_id.as_str(),
                        folder.as_str(),
                        &after,
                        limit
                    )?;
                    let full_page = rows.len() as i64 == limit;
                    for (note, parent, class) in rows {
                        let parent = FolderId::parse(&parent)?;
                        let class = crate::codec::doc_class_from_db(&class)?;
                        let (facts, _) = cache
                            .build_resource_facts_tx(tx, &space.space, &parent, class, None, true)
                            .await?;
                        let authorized = ctx.auth().can_view_resource(&facts).is_ok();
                        if authorized {
                            visible.push(NoteId::parse(&note)?);
                            if visible.len() as i64 == limit {
                                break;
                            }
                        }
                        after = note;
                    }
                    if !full_page {
                        break;
                    }
                }
                Ok(visible)
            })
        })
        .await
    }

    pub async fn read_vault_schema(
        &self,
        ctx: &SpaceContext,
    ) -> Result<Option<VaultSchema>, PortError> {
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let space = load_space_record(tx, &ctx.scope().space_id).await?;
                space.scope.check(ctx.scope())?;
                if let Some(schema) =
                    load_current_space_schema_tx(tx, &space.scope.space_id).await?
                {
                    if !crate::domain::folders::is_note_live_readable_tx(
                        tx,
                        &space.space,
                        ctx.auth(),
                        &schema.schema_note_id,
                    )
                    .await?
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    return Ok(Some(VaultSchema {
                        revision: schema.schema_revision,
                        fingerprint: schema.descriptor_fingerprint,
                        fields: schema.fields,
                    }));
                }
                ctx.auth().authorize_folder_read(
                    &space.space,
                    &space.root_folder_id,
                    std::slice::from_ref(&space.root_folder_id),
                )?;
                Ok(None)
            })
        })
        .await
    }

    /// Guarded automatic import. The ID written into the normalized carrier
    /// must not hide the original ID from the permanent purge fence.
    pub async fn import_vault_note(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        request: Mutation<VaultImport>,
    ) -> Result<Committed<NoteRevision>, PortError> {
        if !is_vault_note(request.input.create.class) {
            return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
        }
        check_path(&request.input.path)?;
        check_file(&request.input.file)?;
        let guard = VaultWrite {
            binding: binding.clone(),
            watch_fence: None,
            change: VaultChange::Import {
                note: request.input.create.note.clone(),
                claimed: request.input.claimed_note,
                destination: Destination {
                    parent: request.input.create.parent.clone(),
                    slug: request.input.create.slug.clone(),
                },
                path: request.input.path,
                file: request.input.file,
            },
        };
        notes::create_note_with_vault(
            self,
            ctx,
            Mutation {
                input: request.input.create,
                identity: request.identity,
                preconditions: request.preconditions,
            },
            Some(guard),
        )
        .await
    }

    pub async fn move_vault_note(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: VaultObservation,
        new_path: VaultPath,
        mut request: Mutation<MoveNote>,
    ) -> Result<Committed<NoteRevision>, PortError> {
        check_path(&new_path)?;
        let target = request.input.note.clone();
        set_expected_revision(&mut request, &expected, &target)?;
        let destination = Destination {
            parent: request.input.parent.clone(),
            slug: request.input.slug.clone(),
        };
        notes::move_note_with_vault(
            self,
            ctx,
            request,
            Some(VaultWrite {
                binding: binding.clone(),
                watch_fence: None,
                change: VaultChange::Move {
                    expected,
                    destination,
                    path: new_path,
                },
            }),
        )
        .await
    }

    /// Applies a deletion inferred from filesystem absence only while the
    /// watcher still confirms the observation cut. The synchronous fence
    /// runs in the writer and must perform only a bounded in-process check.
    pub async fn trash_vault_note_with_fence(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: VaultObservation,
        mut request: Mutation<DeleteNote>,
        still_safe: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<Committed<NoteRevision>, PortError> {
        if request.input.disposition != DeleteDisposition::Trash {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let target = request.input.note.clone();
        set_expected_revision(&mut request, &expected, &target)?;
        let fence: WatchFence = Arc::new(still_safe);
        match notes::delete_note_with_vault(
            self,
            ctx,
            request,
            Some(VaultWrite {
                binding: binding.clone(),
                watch_fence: Some(fence.clone()),
                change: VaultChange::Trash { expected },
            }),
        )
        .await
        {
            Err(PortError::Unavailable(_)) if !fence() => Err(observation_changed()),
            result => result,
        }
    }

    pub async fn accept_vault_observation(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: VaultObservation,
        request: Mutation<ExternalObservation>,
    ) -> Result<ExternalObservationResult, PortError> {
        if request.input.note != expected.note || request.input.base_revision != expected.revision {
            return Err(observation_changed());
        }
        notes::accept_external_observation_with_vault(
            self,
            ctx,
            request,
            Some(VaultWrite {
                binding: binding.clone(),
                watch_fence: None,
                change: VaultChange::Edit { expected },
            }),
        )
        .await
    }

    pub async fn vault_is_purge_fenced(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        let note = note.clone();
        self.read_vault_state(ctx, binding, move |tx, binding| {
            Box::pin(async move {
                is_note_purge_fenced_tx(tx, &binding.scope.space_id, note.as_str()).await
            })
        })
        .await
    }
}

fn set_expected_revision<T>(
    request: &mut Mutation<T>,
    expected: &VaultObservation,
    target: &NoteId,
) -> Result<(), PortError> {
    if &expected.note != target
        || request
            .preconditions
            .revision
            .as_ref()
            .is_some_and(|rev| rev != &expected.revision)
    {
        return Err(observation_changed());
    }
    request.preconditions.revision = Some(expected.revision.clone());
    Ok(())
}

type WatchFence = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub(crate) struct VaultWrite {
    binding: VaultBinding,
    change: VaultChange,
    watch_fence: Option<WatchFence>,
}

#[derive(Clone, Serialize)]
enum VaultChange {
    Import {
        note: NoteId,
        claimed: Option<NoteId>,
        destination: Destination,
        path: VaultPath,
        file: VaultFileStamp,
    },
    Move {
        expected: VaultObservation,
        destination: Destination,
        path: VaultPath,
    },
    Trash {
        expected: VaultObservation,
    },
    Edit {
        expected: VaultObservation,
    },
}

#[derive(Clone, Serialize)]
struct Destination {
    parent: Option<FolderId>,
    slug: String,
}

impl Destination {
    async fn require_path(
        &self,
        tx: &mut BackendConn<'_>,
        space: &SpaceRecord,
        path: &VaultPath,
    ) -> Result<(), PortError> {
        let parent = self.parent.as_ref().unwrap_or(&space.root_folder_id);
        let ancestors = load_folder_ancestry_tx(tx, &space.scope.space_id, parent, true).await?;
        let filename = PortableFilename::note_slug(&self.slug)?;
        let name = if ancestors.folder_path.is_empty() {
            filename.as_str().to_owned()
        } else {
            format!("{}/{}", ancestors.folder_path, filename.as_str())
        };
        if lookup_key(&name) != lookup_key(&path.relative) {
            return Err(observation_changed());
        }
        Ok(())
    }
}

impl VaultWrite {
    pub(crate) fn observation_witness(&self) -> Result<ContentDigest, PortError> {
        let bytes = CanonicalStore::encode_command_outcome(&(
            self.binding.generation,
            self.binding.root_identity,
            &self.change,
        ))?;
        let mut hasher = blake3::Hasher::new_derive_key("notarium v1 vault observation witness");
        hasher.update(&bytes);
        Ok(ContentDigest::from_bytes(*hasher.finalize().as_bytes()))
    }

    pub(crate) async fn check_observation_witness(
        tx: &mut BackendConn<'_>,
        ctx: &SpaceContext,
        space: &SpaceRecord,
        note: &NoteId,
        witness: ContentDigest,
    ) -> Result<(), PortError> {
        check_actor(ctx.auth(), ctx.scope(), space)?;
        let binding = active_binding_tx(tx, &space.scope, ctx.auth())
            .await?
            .filter(|binding| binding.scope == space.scope)
            .ok_or_else(observation_changed)?;
        let expected = observation_for_note_tx(tx, &binding, note)
            .await?
            .ok_or_else(observation_changed)?;
        let current = Self {
            binding,
            change: VaultChange::Edit { expected },
            watch_fence: None,
        };
        if current.observation_witness()? != witness {
            return Err(observation_changed());
        }
        Ok(())
    }

    pub(crate) async fn require_current_binding(
        &self,
        store: &CanonicalStore,
        ctx: &SpaceContext,
    ) -> Result<(), PortError> {
        store
            .read_vault_state(ctx, &self.binding, |_, _| Box::pin(async { Ok(()) }))
            .await
    }

    pub(crate) async fn require_current_observation(
        &self,
        store: &CanonicalStore,
        ctx: &SpaceContext,
    ) -> Result<(), PortError> {
        store
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                let ctx = ctx.clone();
                let guard = self.clone();
                Box::pin(async move { guard.check(tx, &ctx).await })
            })
            .await
    }

    pub(crate) fn fingerprint(&self, idemp: &mut CommandIdentitySpec) -> Result<(), PortError> {
        let witness = CanonicalStore::encode_command_outcome(&(
            self.binding.generation,
            self.binding.root_identity,
            &self.change,
        ))?;
        let mut hash = blake3::Hasher::new();
        hash.update(b"vault-command-v1");
        hash.update(idemp.command_hash.as_bytes());
        hash.update(&witness);
        idemp.command_hash = ContentDigest::from_bytes(*hash.finalize().as_bytes());
        Ok(())
    }

    pub(crate) fn wrap(
        self,
        ctx: SpaceContext,
        mut intent: PreparedWriteIntent,
        create_digest: Option<ContentDigest>,
    ) -> PreparedWriteIntent {
        let original = intent.execute;
        intent.execute = Box::new(move |tx, item| {
            Box::pin(async move {
                self.check(tx, &ctx).await?;
                let fence = self.watch_fence.clone();
                if fence.as_ref().is_some_and(|fence| !fence()) {
                    return Err(observation_changed());
                }
                let result = original(tx, item).await?;
                self.apply(tx, &result.response_bytes, create_digest)
                    .await?;
                if let Some(fence) = fence {
                    if !fence() {
                        return Err(observation_changed());
                    }
                    item.require_before_commit(move || {
                        if fence() {
                            Ok(())
                        } else {
                            Err(unavailable_retryable(
                                "vault_watch_cut_changed",
                                "filesystem observation changed before writer commit",
                                Duration::from_millis(25),
                            ))
                        }
                    });
                }
                Ok(result)
            })
        });
        intent
    }

    pub(crate) async fn check(
        &self,
        tx: &mut BackendConn<'_>,
        ctx: &SpaceContext,
    ) -> Result<(), PortError> {
        let space = load_space_record(tx, &ctx.scope().space_id).await?;
        require_binding_tx(tx, ctx, &space, &self.binding).await?;
        match &self.change {
            VaultChange::Import {
                note,
                claimed,
                destination,
                path,
                file,
            } => {
                for note in std::iter::once(note).chain(claimed.as_ref()) {
                    if is_note_purge_fenced_tx(tx, &space.scope.space_id, note.as_str()).await? {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                }
                if observation_for_key_tx(tx, &self.binding, &path.key)
                    .await?
                    .is_some()
                {
                    return Err(path_conflict(&self.binding, path));
                }
                destination.require_path(tx, &space, path).await?;
                guarded_candidate_tx(tx, &self.binding, path, file, claimed.as_ref()).await?;
            }
            VaultChange::Move { expected, .. }
            | VaultChange::Trash { expected }
            | VaultChange::Edit { expected } => {
                if observation_for_note_tx(tx, &self.binding, &expected.note)
                    .await?
                    .as_ref()
                    != Some(expected)
                {
                    return Err(observation_changed());
                }
                if load_active_note_tx(tx, &space, ctx, &expected.note)
                    .await?
                    .is_none()
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if let VaultChange::Move {
                    destination, path, ..
                } = &self.change
                {
                    destination.require_path(tx, &space, path).await?;
                    guarded_candidate_tx(
                        tx,
                        &self.binding,
                        path,
                        &expected.file,
                        Some(&expected.note),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    async fn apply(
        self,
        tx: &mut BackendConn<'_>,
        response: &[u8],
        create_digest: Option<ContentDigest>,
    ) -> Result<(), PortError> {
        match self.change {
            VaultChange::Import {
                note, path, file, ..
            } => {
                let carrier_digest = create_digest.ok_or_else(|| {
                    internal_not_committed(
                        "vault_import_digest_missing",
                        "creation digest not available",
                    )
                })?;
                let stored: StoredCommittedNoteRevV1 = decode_note_result(response)?;
                let observed = VaultObservation {
                    note,
                    revision: stored.value.revision,
                    path,
                    file,
                    carrier_digest,
                };
                upsert_observation_tx(tx, &self.binding, &observed).await?;
            }
            VaultChange::Move {
                mut expected, path, ..
            } => {
                let stored: StoredCommittedNoteRevV1 = decode_note_result(response)?;
                expected.path = path;
                expected.revision = stored.value.revision;
                upsert_observation_tx(tx, &self.binding, &expected).await?;
            }
            VaultChange::Trash { expected } => {
                delete_observation_tx(tx, &self.binding, &expected.note).await?;
            }
            VaultChange::Edit { .. } => {}
        }
        Ok(())
    }
}

fn decode_note_result(bytes: &[u8]) -> Result<StoredCommittedNoteRevV1, PortError> {
    rmp_serde::from_slice(bytes)
        .map_err(|err| internal_not_committed("vault_note_result", err.to_string()))
}
