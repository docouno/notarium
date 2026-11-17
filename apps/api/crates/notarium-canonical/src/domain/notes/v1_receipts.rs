//! Verify v1 note receipts using the immutable revision returned by the original command.
use super::*;
use crate::writer::CommandIdentitySpec;
use notarium_core::ids::FolderId;

pub(super) struct CreatedNote {
    note: NoteId,
    parent: FolderId,
    slug: String,
    class: DocClass,
    digest: ContentDigest,
}

impl CreatedNote {
    pub(super) fn from_input(input: &CreateNote, root: &FolderId, digest: ContentDigest) -> Self {
        Self {
            note: input.note.clone(),
            parent: input.parent.as_ref().unwrap_or(root).clone(),
            slug: input.slug.clone(),
            class: input.class,
            digest,
        }
    }
}

pub(super) enum LegacyNoteCommand<'a> {
    Create(CreatedNote),
    Edit(&'a EditNote, &'a Preconditions),
}

struct RecordedNote {
    hash: ContentDigest,
    meta: NoteRevisionMetadata,
    parent_revision: Option<String>,
    base_digest: Option<Vec<u8>>,
}

impl RecordedNote {
    fn matches_hash(
        &self,
        identity: &CommandIdentity,
        kind: &str,
        payload: &blake3::Hasher,
    ) -> bool {
        derive_command_identity_spec(identity, kind, payload.finalize().as_bytes()).command_hash()
            == self.hash
    }

    fn matches_create(&self, identity: &CommandIdentity, create: &CreatedNote) -> bool {
        if self.parent_revision.is_some()
            || create.parent != self.meta.parent_folder_id
            || create.class != self.meta.doc_class
            || create.slug != self.meta.slug
            || Some(create.digest) != self.meta.content_digest
        {
            return false;
        }
        // Batch omitted parent and class. Single encoded an explicit root literally.
        let single = [
            create.note.as_str(),
            create.parent.as_str(),
            &create.slug,
            doc_class_to_db(create.class),
        ];
        let batch = [create.note.as_str(), &create.slug];
        [single.as_slice(), batch.as_slice()]
            .into_iter()
            .any(|parts| {
                let mut hash = blake3::Hasher::new();
                for part in parts {
                    hash.update(part.as_bytes());
                    hash.update(&[0]);
                }
                hash.update(create.digest.as_bytes());
                self.matches_hash(identity, "create_note", &hash)
            })
    }

    async fn matches_edit(
        &self,
        store: &CanonicalStore,
        ctx: &SpaceContext,
        identity: &CommandIdentity,
        edit: &EditNote,
        pre: &Preconditions,
    ) -> Result<bool, PortError> {
        let Some(result_digest) = self.meta.content_digest else {
            return Ok(false);
        };
        if pre.lease.is_some()
            || pre.lineage.is_some()
            || pre
                .revision
                .as_ref()
                .is_some_and(|r| Some(r.as_str()) != self.parent_revision.as_deref())
            || self.base_digest.as_deref()
                != Some(edit.plan.base_content_hash.as_bytes().as_slice())
        {
            return Ok(false);
        }
        let mut prefix = blake3::Hasher::new();
        prefix.update(edit.note.as_str().as_bytes());
        prefix.update(&[0]);
        prefix.update(edit.plan.base_content_hash.as_bytes());
        let mut batch = prefix.clone();
        batch.update(&[0]);
        batch.update(result_digest.as_bytes());
        if !self.matches_hash(identity, "edit_note", &batch) {
            // V1 single-edit receipts serialized byte offsets with the original writer's usize.
            let single_matches = [4, 8].into_iter().any(|width| {
                let mut single = prefix.clone();
                for splice in &edit.plan.edits {
                    single.update(&[0]);
                    for offset in [splice.bytes.0.start(), splice.bytes.0.end()] {
                        if width == 4 && u32::try_from(offset).is_err() {
                            return false;
                        }
                        single.update(&(offset as u64).to_be_bytes()[8 - width..]);
                    }
                    single.update(splice.replacement.as_bytes());
                }
                self.matches_hash(identity, "edit_note", &single)
            });
            if !single_matches {
                return Ok(false);
            }
        }
        // Verify derived coordinates and the originally committed effect, outside the SQL read.
        let raw = store
            .read_verified_blob(ctx.scope(), edit.plan.base_content_hash)
            .await?;
        let base = std::str::from_utf8(&raw)
            .map_err(|_| internal_not_committed("invalid_v1_edit_base", "invalid UTF-8"))?;
        let body = notarium_syntax::frontmatter::analyze(base, self.meta.doc_class)?
            .carrier
            .body;
        Ok(body == edit.plan.body_range
            && notarium_syntax::patch::apply(base, &edit.plan)
                .is_ok_and(|next| notarium_syntax::content_digest(&next) == result_digest))
    }
}

const READ_REVISION: &str =
    "SELECT r.metadata_msgpack, r.parent_rev_id, p.content_blake3 FROM revisions r
     LEFT JOIN revisions p ON p.space_id=r.space_id AND p.rev_id=r.parent_rev_id
                            AND p.history_incarnation=r.history_incarnation
                            AND p.entity_type=r.entity_type AND p.entity_key=r.entity_key
     WHERE r.space_id=$1 AND r.history_incarnation=$2 AND r.rev_id=$3
       AND r.entity_type='note' AND r.entity_key=$4 AND r.visibility_seq=$5";

async fn recorded_note_tx(
    tx: &mut BackendConn<'_>,
    scope: &notarium_core::model::HistoryScope,
    note: &NoteId,
    current: &CommandIdentitySpec,
) -> Result<RecordedNote, PortError> {
    let mismatch = || PortError::from(DomainError::IdempotencyKeyReused);
    let receipt = crate::writer::lookup_command_receipt_tx(tx, scope, current)
        .await?
        .ok_or_else(mismatch)?;
    let outcome: StoredCommittedNoteRevV1 =
        rmp_serde::from_slice(&receipt.response_blob).map_err(|_| mismatch())?;
    if receipt.status != "completed"
        || &outcome.value.note != note
        || outcome.receipt.scope() != scope
    {
        return Err(mismatch());
    }
    type RevisionProofRow = (Vec<u8>, Option<String>, Option<Vec<u8>>);
    let row: Option<RevisionProofRow> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(READ_REVISION)
                .bind(scope.space_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(outcome.value.revision.as_str())
                .bind(note.as_str())
                .bind(outcome.receipt.seq().get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(READ_REVISION)
                .bind(scope.space_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(outcome.value.revision.as_str())
                .bind(note.as_str())
                .bind(outcome.receipt.seq().get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|e| internal_not_committed("read_v1_receipt_revision", e.to_string()))?;
    let (bytes, parent_revision, base_digest) = row.ok_or_else(mismatch)?;
    let RevisionMetadataPayload::Note(meta) = RevisionMetadataEnvelope::decode(&bytes)?.payload
    else {
        return Err(mismatch());
    };
    Ok(RecordedNote {
        hash: receipt.command_hash,
        meta,
        parent_revision,
        base_digest,
    })
}

impl LegacyNoteCommand<'_> {
    pub(super) async fn verified_identity(
        &self,
        store: &CanonicalStore,
        ctx: &SpaceContext,
        identity: &CommandIdentity,
        current: &CommandIdentitySpec,
    ) -> Result<CommandIdentitySpec, PortError> {
        let note = match self {
            Self::Create(create) => &create.note,
            Self::Edit(edit, _) => &edit.note,
        }
        .clone();
        let scope = ctx.scope().clone();
        let spec = current.clone();
        let record = store
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move { recorded_note_tx(tx, &scope, &note, &spec).await })
            })
            .await?;
        let valid = match self {
            Self::Create(create) => record.matches_create(identity, create),
            Self::Edit(edit, pre) => record.matches_edit(store, ctx, identity, edit, pre).await?,
        };
        if !valid {
            return Err(DomainError::IdempotencyKeyReused.into());
        }
        let mut legacy = current.clone();
        legacy.command_hash = record.hash;
        Ok(legacy)
    }

    pub(super) async fn replay(
        &self,
        store: &CanonicalStore,
        ctx: &SpaceContext,
        identity: &CommandIdentity,
        current: &CommandIdentitySpec,
    ) -> Result<Committed<NoteRevision>, PortError> {
        let legacy = self
            .verified_identity(store, ctx, identity, current)
            .await?;
        let stored = try_replay_completed_receipt::<StoredCommittedNoteRevV1>(
            store,
            ctx.scope(),
            &legacy,
            Some(&ctx.budget),
        )
        .await?;
        stored
            .map(StoredCommittedNoteRevV1::into_committed)
            .ok_or(DomainError::IdempotencyKeyReused.into())
    }
}
