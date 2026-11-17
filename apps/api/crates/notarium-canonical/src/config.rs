use std::{path::PathBuf, time::Duration};

use notarium_core::{
    DomainError, DomainResult,
    epoch::{CLOUD_CANONICAL_SCHEMA, DataRoot},
    error::ValidationReason,
    ids::InstallationId,
    ports::{BackupBudget, BackupRetentionBudget},
};

/// Validates an internal PostgreSQL schema identifier before DDL or `search_path` use.
///
/// Only ASCII lowercase identifiers starting with `[a-z_]` (`v1_canonical` or `test_<id>`)
/// are accepted; external user input is never interpolated as a schema name.
pub fn validate_pg_schema_name(schema: &str) -> DomainResult<&str> {
    let bytes = schema.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return Err(DomainError::validation(ValidationReason::InvalidId));
    }
    if !(bytes[0].is_ascii_lowercase() || bytes[0] == b'_') {
        return Err(DomainError::validation(ValidationReason::InvalidId));
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
    {
        return Err(DomainError::validation(ValidationReason::InvalidId));
    }
    if schema != CLOUD_CANONICAL_SCHEMA && !schema.starts_with("test_") {
        return Err(DomainError::validation(ValidationReason::InvalidId));
    }
    Ok(schema)
}

#[derive(Clone, Debug)]
pub enum PgTransport {
    UnixSocket {
        socket_dir: PathBuf,
        port: u16,
    },
    Tcp {
        host: String,
        port: u16,
        /// Optional PEM trust anchor for servers with a private CA.
        root_cert: Option<PathBuf>,
    },
}

#[derive(Clone)]
pub struct PgConnectConfig {
    pub transport: PgTransport,
    pub username: String,
    pub password: String,
    pub database: String,
}

impl std::fmt::Debug for PgConnectConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgConnectConfig")
            .field("transport", &self.transport)
            .field("database", &self.database)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub enum SqlBackendConfig {
    Sqlite {
        data_root: DataRoot,
        read_pool_size: u32,
        read_deadline: Duration,
        passive_checkpoint_interval: Duration,
        wal_soft_watermark_bytes: u64,
        wal_high_watermark_bytes: u64,
        wal_reset_cycle_deadline: Duration,
    },
    Postgres {
        connect: PgConnectConfig,
        schema: String,
        pool_size: u32,
        statement_timeout: Duration,
    },
}

impl SqlBackendConfig {
    pub fn sqlite_default(data_root: DataRoot) -> Self {
        Self::Sqlite {
            data_root,
            read_pool_size: 8,
            read_deadline: Duration::from_millis(248),
            passive_checkpoint_interval: Duration::from_millis(15),
            wal_soft_watermark_bytes: 512 * 1024 * 1024,
            wal_high_watermark_bytes: 896 * 1024 * 1024,
            wal_reset_cycle_deadline: Duration::from_millis(250),
        }
    }

    pub fn postgres_default(connect: PgConnectConfig, schema: impl Into<String>) -> Self {
        Self::Postgres {
            connect,
            schema: schema.into(),
            pool_size: 8,
            statement_timeout: Duration::from_millis(240),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum S3AddressingStyle {
    PathStyle,
    VirtualHosted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum S3BucketMode {
    NeverVersioned,
    Enabled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum S3BucketModePolicy {
    /// Query `GetBucketVersioning` at startup and enforce `NeverVersioned` or `Enabled`.
    DetectFromBucket,
    /// Explicit operator assertion for versionless S3 services that do not implement
    /// `GetBucketVersioning`; permission errors on versioned endpoints still fail closed.
    ExplicitNeverVersioned,
    /// Require `GetBucketVersioning` to report `Enabled`.
    RequireEnabled,
}

#[derive(Clone)]
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

impl std::fmt::Debug for S3Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Credentials")
            .field("access_key_id", &self.access_key_id)
            .field("has_session_token", &self.session_token.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub application_prefix: String,
    pub addressing: S3AddressingStyle,
    pub credentials: S3Credentials,
    pub custom_ca_pem: Option<Vec<u8>>,
    /// Test-only Unix domain socket transport that preserves the original `Host` header for SigV4.
    pub unix_socket: Option<PathBuf>,
    pub bucket_mode_policy: S3BucketModePolicy,
    pub request_timeout: Duration,
}

#[derive(Clone, Debug)]
pub enum BlobBackendConfig {
    Local { data_root: DataRoot },
    S3(Box<S3Config>),
}

#[derive(Clone, Copy, Debug)]
pub struct WriterConfig {
    pub mailbox_capacity: usize,
    pub max_staged_bytes: u64,
    pub batch_flush_window: Duration,
    pub max_batch_items: usize,
    pub receipt_ttl: Duration,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            mailbox_capacity: 4096,
            max_staged_bytes: 256 * 1024 * 1024,
            batch_flush_window: Duration::from_millis(2),
            max_batch_items: 64,
            receipt_ttl: Duration::from_secs(24 * 60 * 60),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CanonicalConfig {
    pub installation_id: InstallationId,
    pub sql: SqlBackendConfig,
    pub blobs: BlobBackendConfig,
    pub writer: WriterConfig,
    pub snapshot_retention: Duration,
    pub default_backup_budget: BackupBudget,
}

impl CanonicalConfig {
    pub fn local_default(installation_id: InstallationId, data_root: DataRoot) -> Self {
        Self {
            installation_id,
            sql: SqlBackendConfig::sqlite_default(data_root.clone()),
            blobs: BlobBackendConfig::Local { data_root },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(5 * 60),
            default_backup_budget: default_backup_budget(),
        }
    }
}

pub fn default_backup_budget() -> BackupBudget {
    BackupBudget {
        deadline: Duration::from_secs(30),
        retention: BackupRetentionBudget::SqliteWal {
            max_pinned_bytes: 256 * 1024 * 1024,
        },
        max_spool_bytes: 8 * 1024 * 1024 * 1024,
    }
}

pub fn default_postgres_backup_budget() -> BackupBudget {
    BackupBudget {
        retention: BackupRetentionBudget::PostgresSnapshot {
            max_age: Duration::from_secs(30),
        },
        ..default_backup_budget()
    }
}
