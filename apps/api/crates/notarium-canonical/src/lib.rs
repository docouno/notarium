#![forbid(unsafe_code)]

//! Canonical storage, content-addressed blob persistence, and atomic write-batch runtime.

use std::{future::Future, pin::Pin};

pub mod backup;
pub mod blobs;
mod catalog;
pub mod changes;
pub mod chats;
pub mod codec;
pub mod config;
mod dialect;
pub mod domain;
pub mod peers;
pub mod runtime;
pub mod schema;
pub(crate) mod sql_exec;
pub(crate) mod sqlite_fast;
pub mod wal;
pub mod writer;

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub use backup::{
    BackupArtifactEncoding, BackupArtifactRecord, BackupExporterMemoryStats,
    DecodedPostgresSpoolTable, DecodedPostgresSpoolV1, PostgresSpoolValue,
    decode_postgres_spool_v1,
};

pub use changes::{
    BroadcastSignal as SpaceSignal, ChangedNoteSummaryV1, CommittedTargets, EFFECT_CODEC_V1,
    EffectBodyV1, EffectEnvelopeV1, StoredAwaitReasonV1, build_effect_payload_draft,
};
pub use config::{
    BlobBackendConfig, CanonicalConfig, PgConnectConfig, PgTransport, S3AddressingStyle,
    S3BucketMode, S3BucketModePolicy, S3Config, S3Credentials, SqlBackendConfig, WriterConfig,
    default_backup_budget, validate_pg_schema_name,
};
#[cfg(feature = "test-support")]
pub use dialect::postgres::build_pg_connect_options;
pub use dialect::{DataRootOwnerLock, sqlite::observe_sqlite_canonical_witness};
pub use domain::{RoomCommandSettlement, RoomFenceTable, SpaceSchemaRevision, UpdateSpaceSchema};
#[cfg(any(test, feature = "test-support"))]
pub use peers::AppendCollabUpdate;
pub use peers::{
    ActiveRoomFacts, AppendCollabUpdates, CheckpointCollabSession, ClaimedContentJob,
    CloseCollabSession, CollabCarrierSettlement, CollabRoomState, CollabSessionRecord,
    CollabSessionSnapshot, CollabSettlementActor, CollabUpdateEntry, FenceCollabSession,
    FencedCollabRecovery, JobCompletionOutcome, NoteCollabAdmission, OpenCollabSession,
    RoomWalEntry,
};
pub use runtime::{
    CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec, SpaceRecord,
    StoredRevisionRecord,
};
pub use schema::manifest::{CANONICAL_SCHEMA_VERSION, CANONICAL_TABLES, manifest_checksum};
pub use wal::WalTelemetrySnapshot;

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use crate::{
        config::validate_pg_schema_name,
        schema::{
            POSTGRES_BASELINE_DDL, SQLITE_BASELINE_DDL,
            manifest::{expected_index_names, expected_table_names},
            split_sql_statements,
        },
    };

    #[test]
    fn package_identity_and_schema_manifest_parity() {
        assert_eq!(env!("CARGO_PKG_NAME"), "notarium-canonical");
        assert!(validate_pg_schema_name("v1_canonical").is_ok());
        assert!(validate_pg_schema_name("test_a1b2c3").is_ok());
        assert!(validate_pg_schema_name("public").is_err());
        assert!(validate_pg_schema_name("test-bad;drop").is_err());

        for (label, ddl) in [
            ("sqlite", SQLITE_BASELINE_DDL),
            ("postgres", POSTGRES_BASELINE_DDL),
        ] {
            let stmts = split_sql_statements(ddl);
            let mut tables = BTreeSet::new();
            let mut indexes = BTreeSet::new();
            for stmt in &stmts {
                let upper = stmt.to_ascii_uppercase();
                if let Some(rest) = upper.strip_prefix("CREATE TABLE IF NOT EXISTS ") {
                    let name_len = rest
                        .find(|c: char| c.is_ascii_whitespace() || c == '(')
                        .expect("table name boundary");
                    let raw_rest = &stmt["CREATE TABLE IF NOT EXISTS ".len()..];
                    tables.insert(raw_rest[..name_len].to_owned());
                } else if let Some(rest) = upper
                    .strip_prefix("CREATE UNIQUE INDEX IF NOT EXISTS ")
                    .or_else(|| upper.strip_prefix("CREATE INDEX IF NOT EXISTS "))
                {
                    let prefix_len = stmt.len() - rest.len();
                    let name_len = rest
                        .find(|c: char| c.is_ascii_whitespace())
                        .expect("index name boundary");
                    indexes.insert(stmt[prefix_len..prefix_len + name_len].to_owned());
                } else {
                    panic!("unexpected top-level statement in {label} DDL: {stmt}");
                }
            }
            let expected_tables: BTreeSet<String> = expected_table_names()
                .into_iter()
                .map(str::to_owned)
                .collect();
            let expected_indexes: BTreeSet<String> = expected_index_names()
                .into_iter()
                .map(str::to_owned)
                .collect();
            assert_eq!(
                tables, expected_tables,
                "{label} tables differ from manifest"
            );
            assert_eq!(
                indexes, expected_indexes,
                "{label} indexes differ from manifest"
            );
        }
        assert!(expected_table_names().contains("account_catalog_receipts"));
    }
}
