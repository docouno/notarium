use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::PortError,
    ids::*,
    model::{HistoryScope, Lifecycle},
    ports::{ChatThreadKind, GroupKey},
    query::{FieldObservation, FieldValue},
    value::Timestamp,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::sql::{Column, SqlColumn, SqlRecord, SqlValue};

macro_rules! record {
    ($(#[$attrs:meta])* $vis:vis struct $name:ident = $table:literal; key($($key:ident),+) {
        $($(#[$field_attrs:meta])* $field:ident: $ty:ty),+ $(,)?
    }) => {
        $(#[$attrs])*
        #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
        $vis struct $name {
            $( $(#[$field_attrs])* pub $field: $ty),+
        }
        impl SqlRecord for $name {
            const TABLE: &'static str = $table;
            const COLUMNS: &'static [Column] = &[$(Column {
                name: stringify!($field),
                kind: <$ty>::KIND,
                nullable: <$ty>::NULLABLE,
            }),+];
            const KEY: &'static [&'static str] = &[$(stringify!($key)),+];
            fn values(&self) -> Vec<SqlValue> {
                vec![$(self.$field.value()),+]
            }
            fn key(&self) -> Vec<SqlValue> {
                vec![$(self.$key.value()),+]
            }
            fn read(values: Vec<SqlValue>) -> Result<Self, PortError> {
                let mut values = values.into_iter();
                Ok(Self {
                    $($field: <$ty>::read(values.next().ok_or_else(super::invalid_row)?)?),+
                })
            }
        }
    };
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectionWatermark {
    pub scope: HistoryScope,
    pub root_folder_id: FolderId,
    pub next_dense_id: u64,
    pub next_dense_folder_id: u64,
    pub projected_seq: SpaceSeq,
    pub snapshot_seq: SpaceSeq,
    pub graph_settled_seq: SpaceSeq,
    pub schema: Option<ProjectionSchema>,
    pub seed_in_progress: bool,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectionSchema {
    pub revision: RevisionId,
    pub fingerprint: ContentDigest,
    pub fields_msgpack: Vec<u8>,
}

record! {
    pub(super) struct WatermarkRecord = "space_projection_watermarks";
    key(space_id) {
        space_id: SpaceId,
        history_incarnation: HistoryIncarnation,
        root_folder_id: FolderId,
        next_dense_id: u64,
        next_dense_folder_id: u64,
        projected_seq: SpaceSeq,
        snapshot_seq: SpaceSeq,
        graph_settled_seq: SpaceSeq,
        schema_rev_id: Option<RevisionId>,
        schema_fingerprint: Option<ContentDigest>,
        schema_msgpack: Option<Vec<u8>>,
        seed_in_progress: bool,
        updated_at_ms: i64,
    }
}

impl WatermarkRecord {
    pub(super) fn watermark(self) -> Result<ProjectionWatermark, PortError> {
        let schema = match (
            self.schema_rev_id,
            self.schema_fingerprint,
            self.schema_msgpack,
        ) {
            (None, None, None) => None,
            (Some(revision), Some(fingerprint), Some(fields_msgpack)) => Some(ProjectionSchema {
                revision,
                fingerprint,
                fields_msgpack,
            }),
            _ => return Err(super::invalid_row()),
        };
        Ok(ProjectionWatermark {
            scope: HistoryScope {
                space_id: self.space_id,
                incarnation: self.history_incarnation,
            },
            root_folder_id: self.root_folder_id,
            next_dense_id: self.next_dense_id,
            next_dense_folder_id: self.next_dense_folder_id,
            projected_seq: self.projected_seq,
            snapshot_seq: self.snapshot_seq,
            graph_settled_seq: self.graph_settled_seq,
            schema,
            seed_in_progress: self.seed_in_progress,
            updated_at_ms: self.updated_at_ms,
        })
    }

    pub(super) fn from_watermark(row: &ProjectionWatermark) -> Self {
        Self {
            space_id: row.scope.space_id.clone(),
            history_incarnation: row.scope.incarnation,
            root_folder_id: row.root_folder_id.clone(),
            next_dense_id: row.next_dense_id,
            next_dense_folder_id: row.next_dense_folder_id,
            projected_seq: row.projected_seq,
            snapshot_seq: row.snapshot_seq,
            graph_settled_seq: row.graph_settled_seq,
            schema_rev_id: row.schema.as_ref().map(|schema| schema.revision.clone()),
            schema_fingerprint: row.schema.as_ref().map(|schema| schema.fingerprint),
            schema_msgpack: row
                .schema
                .as_ref()
                .map(|schema| schema.fields_msgpack.clone()),
            seed_in_progress: row.seed_in_progress,
            updated_at_ms: row.updated_at_ms,
        }
    }
}

record! {
    pub struct ProjectedNote = "projected_notes";
    key(space_id, dense_id) {
        space_id: SpaceId,
        dense_id: u32,
        note_id: NoteId,
        rev_id: RevisionId,
        parent_folder_id: FolderId,
        dense_folder_id: u32,
        ability_id: Option<AbilityId>,
        slug: String,
        slug_fold: String,
        title: String,
        title_fold: String,
        preview: String,
        doc_class: DocClass,
        lifecycle: Lifecycle,
        byte_size: u64,
        content_digest: Option<ContentDigest>,
        #[serde(with = "msgpack_bytes")]
        tags_msgpack: Vec<u8>,
        #[serde(with = "msgpack_bytes")]
        view_blocks_msgpack: Vec<u8>,
        created_at_sec: i64,
        created_at_nsec: u32,
        updated_at_sec: i64,
        updated_at_nsec: u32,
        #[serde(with = "msgpack_bytes")]
        raw_fields_msgpack: Vec<u8>,
        #[serde(with = "msgpack_bytes")]
        header_diagnostic_msgpack: Vec<u8>,
        #[serde(with = "msgpack_bytes")]
        evaluated_fields_msgpack: Vec<u8>,
        #[serde(with = "msgpack_bytes")]
        diagnostics_msgpack: Vec<u8>,
        rank_version: ContentDigest,
        has_pending_nota: bool,
        has_invalid_nota: bool,
    }
}

impl ProjectedNote {
    pub fn created_at(&self) -> Result<Timestamp, DomainError> {
        Timestamp::from_unix_parts(self.created_at_sec, self.created_at_nsec)
    }

    pub fn updated_at(&self) -> Result<Timestamp, DomainError> {
        Timestamp::from_unix_parts(self.updated_at_sec, self.updated_at_nsec)
    }

    pub fn evaluated_fields(
        &self,
    ) -> Result<BTreeMap<String, FieldObservation<FieldValue>>, PortError> {
        if self.doc_class == DocClass::EncryptedNote {
            return Ok(BTreeMap::new());
        }
        decode(&self.evaluated_fields_msgpack)
    }
}

// Read-only projection of projected_notes. Query fallback never fetches titles,
// previews, raw frontmatter, or authored view blocks.
record! {
    pub struct ProjectedQueryRow = "projected_notes";
    key(space_id, dense_id) {
        space_id: SpaceId,
        dense_id: u32,
        note_id: NoteId,
        updated_at_sec: i64,
        updated_at_nsec: u32,
        evaluated_fields_msgpack: Vec<u8>,
    }
}

impl ProjectedQueryRow {
    pub fn updated_at(&self) -> Result<Timestamp, DomainError> {
        Timestamp::from_unix_parts(self.updated_at_sec, self.updated_at_nsec)
    }

    pub fn evaluated_fields(
        &self,
    ) -> Result<BTreeMap<String, FieldObservation<FieldValue>>, PortError> {
        decode(&self.evaluated_fields_msgpack)
    }
}

record! {
    pub struct ProjectedFolder = "projected_folders";
    key(space_id, folder_id) {
        space_id: SpaceId,
        folder_id: FolderId,
        dense_folder_id: u32,
        parent_folder_id: Option<FolderId>,
        slug: String,
        slug_fold: String,
        display_name: String,
        norm_path_prefix: Option<String>,
        display_path_prefix: String,
        is_project: bool,
        project_slug: Option<String>,
        project_folder_id: Option<FolderId>,
        cover_note_id: Option<NoteId>,
        write_locked: bool,
        lifecycle: Lifecycle,
        head_rev_id: RevisionId,
        active_note_count: u64,
    }
}

record! {
    pub struct ProjectedFolderAlias = "projected_folder_aliases";
    key(space_id, old_parent_folder_id, old_slug_fold, created_seq, target_folder_id) {
        space_id: SpaceId,
        old_parent_folder_id: FolderId,
        old_slug_fold: String,
        created_seq: SpaceSeq,
        target_folder_id: FolderId,
    }
}

record! {
    pub struct ProjectedNoteAlias = "projected_note_aliases";
    key(space_id, old_parent_folder_id, old_slug_fold, created_seq, target_note_id) {
        space_id: SpaceId,
        old_parent_folder_id: FolderId,
        old_slug_fold: String,
        old_title_norm: String,
        created_seq: SpaceSeq,
        target_note_id: NoteId,
    }
}

record! {
    pub struct ProjectedViewDescriptor = "projected_view_descriptors";
    key(space_id, view_note_id, view_key) {
        space_id: SpaceId,
        view_note_id: NoteId,
        view_key: ViewKey,
        view_note_rev_id: RevisionId,
        schema_rev_id: Option<RevisionId>,
        state: String,
        view_kind: Option<String>,
        view_fingerprint: Option<ContentDigest>,
        #[serde(with = "msgpack_bytes::optional")]
        compiled_msgpack: Option<Vec<u8>>,
        #[serde(with = "msgpack_bytes")]
        diagnostics_msgpack: Vec<u8>,
    }
}

record! {
    pub struct ProjectedViewRank = "projected_view_ranks";
    key(space_id, view_note_id, view_key, target_note_id) {
        space_id: SpaceId,
        view_note_id: NoteId,
        view_key: ViewKey,
        target_note_id: NoteId,
        group_key_hex: String,
        #[serde(with = "msgpack_bytes")]
        group_key_msgpack: Vec<u8>,
        sort_rank_lexo: String,
        rank_rev_id: RevisionId,
        placement_revision: RevisionId,
        updated_seq: SpaceSeq,
    }
}

// A group-order scan needs only the two trailing columns of the existing index.
record! {
    pub(crate) struct GroupRankPosition = "projected_view_ranks";
    key(target_note_id) {
        sort_rank_lexo: String,
        target_note_id: NoteId,
    }
}

impl ProjectedViewRank {
    pub fn group_key(&self) -> Result<GroupKey, PortError> {
        decode(&self.group_key_msgpack)
    }
}

record! {
    pub struct CandidateLookupKey = "candidate_lookup_keys";
    key(space_id, tier, scope_folder_dense_id, leaf_norm_key, target_dense_id) {
        space_id: SpaceId,
        tier: u32,
        scope_folder_dense_id: i64,
        leaf_norm_key: String,
        target_dense_id: u32,
        target_note_id: NoteId,
        created_at_sec: i64,
        created_at_nsec: u32,
    }
}

record! {
    pub struct ProjectedLink = "projected_note_links";
    key(space_id, src_dense_id, link_ord) {
        space_id: SpaceId,
        src_dense_id: u32,
        link_ord: u32,
        src_folder_id: FolderId,
        raw_target: String,
        target_kind_tag: u32,
        dir_norm_prefix: String,
        leaf_norm_key: String,
        uses_relative_prefix: bool,
        resolved_dense_id: Option<u32>,
        resolved_tier: Option<u32>,
    }
}

record! {
    pub struct ProjectedChatThread = "projected_chat_threads";
    key(space_id, thread_id) {
        space_id: SpaceId,
        thread_id: ChatThreadId,
        kind: ChatThreadKind,
        owner_id: PrincipalId,
        project_folder_id: Option<FolderId>,
        tainted: bool,
        updated_seq: SpaceSeq,
    }
}

record! {
    pub struct ProjectedChatRef = "chat_note_refs";
    key(target_space_id, target_note_id, thread_space_id, thread_id, entry_seq) {
        target_space_id: SpaceId,
        target_note_id: NoteId,
        thread_space_id: SpaceId,
        thread_id: ChatThreadId,
        entry_seq: ThreadEntrySeq,
        source_incarnation: HistoryIncarnation,
        target_incarnation: HistoryIncarnation,
        source_revision: RevisionId,
        ref_ordinal: u64,
    }
}

record! {
    pub struct ProjectedCluster = "graph_clusters";
    key(space_id, cluster_id) {
        space_id: SpaceId,
        cluster_id: ClusterId,
        member_count: u64,
        anchor_note_id: NoteId,
        #[serde(with = "msgpack_bytes")]
        members_roaring: Vec<u8>,
        #[serde(with = "msgpack_bytes")]
        inter_edges_msgpack: Vec<u8>,
        updated_seq: SpaceSeq,
    }
}

record! {
    /// Digest issued by the writer after the checkpoint file reaches stable storage.
    pub struct TrustedCheckpoint = "projection_checkpoints";
    key(space_id, history_incarnation, seq, format_version, platform_abi, publication_id) {
        space_id: SpaceId,
        history_incarnation: HistoryIncarnation,
        seq: SpaceSeq,
        format_version: u32,
        platform_abi: String,
        publication_id: String,
        file_nonce: String,
        size_bytes: u64,
        digest: ContentDigest,
        graph_seq: SpaceSeq,
    }
}

pub(super) fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, PortError> {
    rmp_serde::to_vec_named(value).map_err(|_| super::invalid_row())
}

// Derived blobs are produced by this engine and already resident after a
// scoped SQL lookup. Their logical values can exceed the canonical metadata
// envelope's unrelated 4 MiB decode cap.
pub(crate) fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, PortError> {
    rmp_serde::from_slice(bytes).map_err(|_| super::invalid_row())
}

// Serialize already encoded blobs as MessagePack binary values. Encoding
// each byte as an integer would inflate staging and consume one serializer
// call per byte. Keep the ordinary sequence form readable as well.
mod msgpack_bytes {
    use std::fmt;

    use serde::{
        Deserialize, Deserializer, Serialize, Serializer,
        de::{SeqAccess, Visitor},
    };

    pub(super) fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(bytes)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<u8>, D::Error> {
        struct BytesVisitor;

        impl<'de> Visitor<'de> for BytesVisitor {
            type Value = Vec<u8>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a binary payload")
            }

            fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<Self::Value, E> {
                Ok(bytes.to_vec())
            }

            fn visit_byte_buf<E: serde::de::Error>(self, bytes: Vec<u8>) -> Result<Self::Value, E> {
                Ok(bytes)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut bytes = Vec::new();
                while let Some(byte) = seq.next_element()? {
                    bytes.push(byte);
                }
                Ok(bytes)
            }
        }

        deserializer.deserialize_bytes(BytesVisitor)
    }

    pub(super) mod optional {
        use super::*;

        #[derive(Serialize)]
        struct BytesRef<'a>(#[serde(serialize_with = "super::serialize")] &'a [u8]);

        #[derive(Deserialize)]
        struct Bytes(#[serde(deserialize_with = "super::deserialize")] Vec<u8>);

        pub(in crate::derived::records) fn serialize<S: Serializer>(
            bytes: &Option<Vec<u8>>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            bytes.as_deref().map(BytesRef).serialize(serializer)
        }

        pub(in crate::derived::records) fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<Vec<u8>>, D::Error> {
            Ok(Option::<Bytes>::deserialize(deserializer)?.map(|bytes| bytes.0))
        }
    }
}
