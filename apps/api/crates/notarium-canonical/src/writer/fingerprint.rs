//! Compatibility for receipts whose original fingerprint omitted command preconditions.
use std::sync::Arc;

use notarium_core::{
    error::PortError,
    ids::{ContentDigest, FolderId, RevisionId},
    model::{HistoryScope, NoteRef},
    ports::{ChatInputBody, Preconditions},
};

use super::{CommandIdentitySpec, replay::UnboundCommand};
use crate::{
    codec::{RevisionMetadataEnvelope, RevisionMetadataPayload},
    runtime::pg_read_error,
    sql_exec::BackendConn,
};

#[derive(Clone, Debug, Default)]
pub(super) struct StoredFingerprints {
    previous_encoding: Option<ContentDigest>,
    legacy: Option<LegacyFingerprint>,
}

#[derive(Clone, Debug)]
struct LegacyFingerprint {
    hash: ContentDigest,
    entity_type: &'static str,
    entity_key: String,
    revision: Option<RevisionId>,
    rename_kind: Option<&'static str>,
    schema: Option<(FolderId, String, Option<RevisionId>)>,
    chat_refs: Option<ContentDigest>,
    staged_size: Option<(ContentDigest, u64)>,
}

fn hash_parts(previous: ContentDigest, parts: &[&[u8]]) -> ContentDigest {
    let mut hash = blake3::Hasher::new_derive_key("notarium command predicates v2");
    hash.update(previous.as_bytes());
    for part in parts {
        hash.update(&(part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    ContentDigest::from_bytes(*hash.finalize().as_bytes())
}

pub(crate) fn chat_reference_digest(refs: &[NoteRef]) -> ContentDigest {
    let mut hash = blake3::Hasher::new_derive_key("notarium ordered chat references v2");
    for reference in refs {
        for id in [reference.space_id.as_str(), reference.note_id.as_str()] {
            hash.update(&(id.len() as u64).to_be_bytes());
            hash.update(id.as_bytes());
        }
    }
    ContentDigest::from_bytes(*hash.finalize().as_bytes())
}

impl UnboundCommand {
    pub(crate) fn with_previous_encoding(mut self, original: Self) -> Self {
        self.0.stored_fingerprints = original.0.stored_fingerprints;
        Arc::make_mut(self.0.stored_fingerprints.get_or_insert_with(Arc::default))
            .previous_encoding = Some(original.0.command_hash);
        self
    }

    pub(crate) fn with_preconditions(
        mut self,
        pre: &Preconditions,
        entity_type: &'static str,
        entity_key: &str,
    ) -> Self {
        // IDs are nonempty and the two counters are bounded by i64::MAX.
        let revision = pre.revision.as_ref().map_or("", RevisionId::as_str);
        let lease = pre.lease.map_or(u64::MAX, |v| v.get()).to_be_bytes();
        let lineage = pre.lineage.map_or(u64::MAX, |v| v.get()).to_be_bytes();
        let old = self.0.command_hash;
        self.0.command_hash = hash_parts(old, &[revision.as_bytes(), &lease, &lineage]);
        if pre.lease.is_none() && pre.lineage.is_none() {
            self.0.stored_fingerprints = Some(Arc::new(StoredFingerprints {
                previous_encoding: None,
                legacy: Some(LegacyFingerprint {
                    hash: old,
                    entity_type,
                    entity_key: entity_key.to_owned(),
                    revision: pre.revision.clone(),
                    rename_kind: None,
                    schema: None,
                    chat_refs: None,
                    staged_size: None,
                }),
            }));
        }
        self
    }

    /// This revision was already part of the original typed input and fingerprint.
    pub(crate) fn with_known_base(mut self, base: &RevisionId) -> Self {
        if let Some(proof) = self.0.legacy_fingerprint_mut()
            && proof.revision.as_ref() == Some(base)
        {
            proof.revision = None;
        }
        self
    }

    pub(crate) fn with_rename_title(mut self, title: Option<&str>) -> Self {
        self.0.command_hash = hash_parts(self.0.command_hash, &[&[u8::from(title.is_some())]]);
        if matches!(title, None | Some("<none>"))
            && let Some(proof) = self.0.legacy_fingerprint_mut()
        {
            proof.rename_kind = Some(if title.is_some() {
                "rename_note"
            } else {
                "move_note"
            });
        }
        self
    }

    pub(crate) fn with_chat_body(mut self, body: &ChatInputBody, refs: &[NoteRef]) -> Self {
        let ref_digest = chat_reference_digest(refs);
        let size = match body {
            ChatInputBody::Text(s) => s.len() as u64,
            ChatInputBody::Staged(staged) => staged.byte_len(),
        };
        self.0.command_hash = hash_parts(
            self.0.command_hash,
            &[&size.to_be_bytes(), ref_digest.as_bytes()],
        );
        if let Some(proof) = self.0.legacy_fingerprint_mut() {
            // Without references the old suffix is unambiguous for a staged body:
            // a staging lease is 16 bytes and the shortest possible reference is 24.
            // An inline body can only overlap a reference if its final 24 bytes
            // consist entirely of characters permitted in a canonical or legacy ID.
            let needs_refs = !refs.is_empty()
                || match body {
                    ChatInputBody::Text(s) => {
                        s.len() >= 24
                            && s.as_bytes()[s.len() - 24..]
                                .iter()
                                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                    }
                    ChatInputBody::Staged(_) => false,
                };
            proof.chat_refs = needs_refs.then_some(ref_digest);
            if let ChatInputBody::Staged(staged) = body {
                proof.staged_size = Some((staged.digest(), staged.byte_len()));
            }
        }
        self
    }

    pub(crate) fn with_schema_placement(
        mut self,
        parent: &FolderId,
        slug: &str,
        expected: Option<&RevisionId>,
    ) -> Self {
        self.0.command_hash = hash_parts(
            self.0.command_hash,
            &[
                parent.as_str().as_bytes(),
                slug.as_bytes(),
                expected.map_or("", RevisionId::as_str).as_bytes(),
            ],
        );
        if let Some(proof) = self.0.legacy_fingerprint_mut() {
            proof.schema = Some((parent.clone(), slug.to_owned(), expected.cloned()));
        }
        self
    }
}

impl CommandIdentitySpec {
    fn legacy_fingerprint_mut(&mut self) -> Option<&mut LegacyFingerprint> {
        Arc::make_mut(self.stored_fingerprints.as_mut()?)
            .legacy
            .as_mut()
    }

    pub(super) fn matches_legacy_detail(&self, stored: &[u8], detail: &[u8]) -> bool {
        let Some(refs) = self
            .stored_fingerprints
            .as_ref()
            .and_then(|stored| stored.legacy.as_ref())
            .filter(|proof| proof.hash.as_bytes() == stored)
            .and_then(|proof| proof.chat_refs)
        else {
            return true;
        };
        crate::chats::recorded_reference_digest(detail) == Some(refs)
    }

    /// Call only after checking current replay authority. Never consult mutable heads for an old predicate.
    pub(crate) async fn matches_receipt_hash(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
        seq: i64,
        stored: &[u8],
    ) -> Result<bool, PortError> {
        if self.command_hash.as_bytes() == stored
            || self
                .stored_fingerprints
                .as_ref()
                .and_then(|stored| stored.previous_encoding)
                .is_some_and(|hash| hash.as_bytes() == stored)
        {
            return Ok(true);
        }
        let Some(proof) = self
            .stored_fingerprints
            .as_ref()
            .and_then(|stored| stored.legacy.as_ref())
            .filter(|p| p.hash.as_bytes() == stored)
        else {
            return Ok(false);
        };
        macro_rules! fetch {
            ($query:expr $(, $arg:expr)* $(,)?) => {
                match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar($query)
                        .bind(scope.space_id.as_str())$(.bind($arg))*.fetch_optional(&mut **conn).await,
                    BackendConn::Postgres(conn) => sqlx::query_scalar($query)
                        .bind(scope.space_id.as_str())$(.bind($arg))*.fetch_optional(&mut **conn).await,
                }.map_err(|e| pg_read_error("read_legacy_command_witness", e))?
            };
        }
        let incarnation = scope.incarnation.as_bytes().as_slice();
        if let Some((digest, size)) = proof.staged_size {
            let bytes: Option<i64> = fetch!(
                "SELECT raw_size FROM blob_catalog WHERE space_id=$1 AND content_blake3=$2",
                digest.as_bytes().as_slice()
            );
            if bytes.and_then(|v| u64::try_from(v).ok()) != Some(size) {
                return Ok(false);
            }
        }
        if let Some(expected) = &proof.revision {
            let parent: Option<Option<String>> = fetch!(
                "SELECT parent_rev_id FROM revisions WHERE space_id=$1 AND history_incarnation=$2
                 AND entity_type=$3 AND entity_key=$4 AND visibility_seq=$5 ORDER BY space_seq LIMIT 1",
                incarnation, proof.entity_type, &proof.entity_key, seq
            );
            if parent.flatten().as_deref() != Some(expected.as_str()) {
                return Ok(false);
            }
        }
        if let Some(kind) = proof.rename_kind {
            let actual: Option<String> = fetch!(
                "SELECT command_kind FROM change_commands WHERE space_id=$1 AND history_incarnation=$2 AND last_seq=$3",
                incarnation,
                seq
            );
            if actual.as_deref() != Some(kind) {
                return Ok(false);
            }
        }
        if let Some((parent, slug, expected)) = &proof.schema {
            let meta: Option<Vec<u8>> = fetch!(
                "SELECT metadata_msgpack FROM revisions WHERE space_id=$1 AND history_incarnation=$2
                 AND entity_type='note' AND entity_key=$3 AND visibility_seq=$4",
                incarnation, &proof.entity_key, seq
            );
            let Some(bytes) = meta else {
                return Ok(false);
            };
            let RevisionMetadataPayload::Note(note) =
                RevisionMetadataEnvelope::decode(&bytes)?.payload
            else {
                return Ok(false);
            };
            if note.parent_folder_id != *parent || note.slug != *slug {
                return Ok(false);
            }
            let previous: Option<String> = fetch!(
                "SELECT schema_rev_id FROM space_field_schemas WHERE space_id=$1 AND visibility_seq<$2 ORDER BY visibility_seq DESC LIMIT 1",
                seq
            );
            if previous.as_deref() != expected.as_ref().map(RevisionId::as_str) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
