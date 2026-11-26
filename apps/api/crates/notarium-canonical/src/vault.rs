//! Canonical state for a Desktop vault binding. File contents and operations
//! are confined to the vault adapter.

use std::collections::BTreeMap;

use notarium_core::{
    classes::DocClass,
    ids::{ContentDigest, FolderId, NoteId, RevisionId, SpaceSeq},
    model::HistoryScope,
    ports::{CreateNote, NoteRevision},
    query::FieldSchema,
};
use serde::{Deserialize, Serialize};

// SQLite and PostgreSQL both use positional dollar parameters in these
// statements. Map affected row counts to the same type for both drivers.
macro_rules! query {
    ($tx:expr, $kind:ident, $sql:expr, $method:ident $(, $arg:expr)* $(,)?) => {{
        match $tx {
            crate::sql_exec::BackendConn::Sqlite(conn) =>
                sqlx::$kind($sql)$(.bind($arg))*.$method(&mut **conn).await,
            crate::sql_exec::BackendConn::Postgres(conn) =>
                sqlx::$kind($sql)$(.bind($arg))*.$method(&mut **conn).await,
        }
        .map_err(|err| crate::codec::internal_not_committed("vault_query", err.to_string()))
    }};
}

macro_rules! execute {
    ($tx:expr, $sql:expr $(, $arg:expr)* $(,)?) => {{
        match $tx {
            crate::sql_exec::BackendConn::Sqlite(conn) =>
                sqlx::query($sql)$(.bind($arg))*.execute(&mut **conn).await.map(|r| r.rows_affected()),
            crate::sql_exec::BackendConn::Postgres(conn) =>
                sqlx::query($sql)$(.bind($arg))*.execute(&mut **conn).await.map(|r| r.rows_affected()),
        }
        .map_err(|err| crate::codec::internal_not_committed("vault_update", err.to_string()))
    }};
}

mod content;
mod folders;
mod storage;

pub(crate) use content::VaultWrite;
pub(crate) use folders::VaultFolderReplay;
pub use notarium_core::ports::VaultFileStamp;
pub(crate) use storage::{handoff_purged_note_tx, upsert_observation_tx};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VaultBinding {
    pub scope: HistoryScope,
    pub generation: ContentDigest,
    pub root_identity: ContentDigest,
    pub cursor: SpaceSeq,
}

/// The adapter supplies the actual relative path and its volume comparison key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VaultPath {
    pub relative: String,
    pub key: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VaultObservation {
    pub note: NoteId,
    pub revision: RevisionId,
    pub path: VaultPath,
    pub file: VaultFileStamp,
    pub carrier_digest: ContentDigest,
}

/// The minimum evidence needed to withdraw a retired publication or hand its
/// name to the encrypted successor. The old note's carrier is never retained.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VaultHandoff {
    pub old_note: NoteId,
    pub new_note: Option<NoteRevision>,
    pub observation: VaultObservation,
    pub purge_seq: SpaceSeq,
}

#[derive(Clone, Debug)]
pub struct VaultImport {
    pub create: CreateNote,
    pub claimed_note: Option<NoteId>,
    pub path: VaultPath,
    pub file: VaultFileStamp,
}

pub struct VaultNote {
    pub note: NoteRevision,
    pub class: DocClass,
    pub parent: FolderId,
    pub folders: Vec<String>,
    pub slug: String,
    pub carrier: String,
    pub carrier_digest: ContentDigest,
}

/// A live canonical folder at a binding-relative sibling name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultFolder {
    pub id: FolderId,
    pub parent: FolderId,
    pub name: String,
    pub revision: RevisionId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultSchema {
    pub revision: RevisionId,
    pub fingerprint: ContentDigest,
    pub fields: BTreeMap<String, FieldSchema>,
}
