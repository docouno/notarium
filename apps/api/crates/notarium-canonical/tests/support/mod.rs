#![allow(dead_code)]

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use notarium_canonical::{
    BlobBackendConfig, CanonicalConfig, PgConnectConfig, PgTransport, S3AddressingStyle,
    S3BucketModePolicy, S3Config, S3Credentials, SqlBackendConfig, WriterConfig,
    build_pg_connect_options,
};
use notarium_core::{
    epoch::DataRoot,
    ids::{
        AgentRunId, FolderId, HistoryIncarnation, InstallationId, NoteId, PrincipalId, RequestId,
        RevisionId, SpaceId,
    },
    ports::{CallBudget, Cancellation, MaintenanceContext, ServiceAuthority, ServicePurpose},
};
use serde::Deserialize;
use sqlx::{Connection, PgConnection, SqliteConnection, sqlite::SqliteConnectOptions};

pub const CANONICAL_V6_HASH: &str =
    "f91526e264d8000bf5d72a4efcb4e9701b350636c37da24d2b34bb19f50a8772";

#[derive(Clone, Debug, Deserialize)]
struct RawFixtureManifest {
    run_id: String,
    checkout_hash: String,
    pg_socket_dir_container: String,
    pg_socket_dir_host: String,
    pg_port: u16,
    pg_fsync_off_port: Option<u16>,
    pg_user: String,
    pg_password: String,
    pg_database: String,
    s3_socket_container: String,
    s3_socket_host: String,
    s3_endpoint: String,
    s3_region: String,
    s3_access_key: String,
    s3_secret_key: String,
    minio_source_commit: String,
    minio_release_tag: String,
}

#[derive(Clone, Debug)]
pub struct StorageTestFixtures {
    pub run_id: String,
    pub pg_socket_dir: PathBuf,
    pub pg_port: u16,
    pub pg_fsync_off_port: Option<u16>,
    pub pg_user: String,
    pub pg_password: String,
    pub pg_database: String,
    pub s3_socket: PathBuf,
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub minio_source_commit: String,
    pub minio_release_tag: String,
}

impl StorageTestFixtures {
    /// Loads the active offline PostgreSQL 16 + MinIO CE fixture manifest, failing closed if absent.
    pub fn load_required() -> Self {
        let manifest_path = if let Some(explicit) =
            std::env::var_os("NOTARIUM_STORAGE_FIXTURES_MANIFEST")
        {
            let p = PathBuf::from(explicit);
            if !p.exists() {
                panic!(
                    "explicit NOTARIUM_STORAGE_FIXTURES_MANIFEST '{}' does not exist (fail-closed); \
                     run via 'make test app=api' or './docker/storage-fixtures/with-storage-fixtures.sh exec-custom ...'",
                    p.display()
                );
            }
            p
        } else {
            let container_manifest = Path::new("/workspace/.artifacts/storage-tests/current.json");
            let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(4)
                .expect("repository root four levels above crate manifest");
            let host_manifest = repo_root.join(".artifacts/storage-tests/current.json");

            if container_manifest.exists() {
                container_manifest.to_path_buf()
            } else if host_manifest.exists() {
                host_manifest
            } else {
                panic!(
                    "offline PostgreSQL 16 + S3 storage fixtures are not running (missing {}); \
                     run via 'make test app=api' or './docker/storage-fixtures/with-storage-fixtures.sh exec-custom ...'",
                    host_manifest.display()
                );
            }
        };

        let raw_bytes = fs::read(&manifest_path).unwrap_or_else(|err| {
            panic!(
                "failed reading fixture manifest {}: {err}",
                manifest_path.display()
            )
        });
        let raw: RawFixtureManifest = serde_json::from_slice(&raw_bytes).unwrap_or_else(|err| {
            panic!(
                "invalid fixture manifest JSON {}: {err}",
                manifest_path.display()
            )
        });

        let pg_sock_name = format!(".s.PGSQL.{}", raw.pg_port);
        let pg_container_dir = PathBuf::from(&raw.pg_socket_dir_container);
        let pg_host_dir = PathBuf::from(&raw.pg_socket_dir_host);
        let pg_socket_dir = if pg_container_dir.join(&pg_sock_name).exists() {
            pg_container_dir
        } else if pg_host_dir.join(&pg_sock_name).exists() {
            pg_host_dir
        } else {
            panic!(
                "PostgreSQL UDS socket '{}' not found in '{}' or '{}'",
                pg_sock_name, raw.pg_socket_dir_container, raw.pg_socket_dir_host
            );
        };

        let s3_container_sock = PathBuf::from(&raw.s3_socket_container);
        let s3_host_sock = PathBuf::from(&raw.s3_socket_host);
        let s3_socket = if s3_container_sock.exists() {
            s3_container_sock
        } else if s3_host_sock.exists() {
            s3_host_sock
        } else {
            panic!(
                "MinIO CE UDS socket not found at '{}' or '{}'",
                raw.s3_socket_container, raw.s3_socket_host
            );
        };

        Self {
            run_id: raw.run_id,
            pg_socket_dir,
            pg_port: raw.pg_port,
            pg_fsync_off_port: raw.pg_fsync_off_port,
            pg_user: raw.pg_user,
            pg_password: raw.pg_password,
            pg_database: raw.pg_database,
            s3_socket,
            s3_endpoint: raw.s3_endpoint,
            s3_region: raw.s3_region,
            s3_access_key: raw.s3_access_key,
            s3_secret_key: raw.s3_secret_key,
            minio_source_commit: raw.minio_source_commit,
            minio_release_tag: raw.minio_release_tag,
        }
    }

    pub fn pg_connect_config(&self) -> PgConnectConfig {
        PgConnectConfig {
            transport: PgTransport::UnixSocket {
                socket_dir: self.pg_socket_dir.clone(),
                port: self.pg_port,
            },
            username: self.pg_user.clone(),
            password: self.pg_password.clone(),
            database: self.pg_database.clone(),
        }
    }

    pub fn fresh_pg_schema(&self) -> String {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).expect("CSPRNG available");
        format!("test_{}", hex::encode(bytes))
    }

    pub async fn open_raw_pg(&self) -> PgConnection {
        let opts = build_pg_connect_options(&self.pg_connect_config());
        PgConnection::connect_with(&opts)
            .await
            .expect("connect raw PostgreSQL 16 UDS fixture")
    }

    pub async fn drop_pg_schema(&self, schema: &str) {
        let mut conn = self.open_raw_pg().await;
        let sql = format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE");
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut conn)
            .await
            .expect("drop isolated test PG schema");
        let _ = conn.close().await;
    }

    pub async fn open_pg_s3_config(
        &self,
        installation_id: InstallationId,
        schema: &str,
    ) -> CanonicalConfig {
        let mut s3_cfg =
            self.s3_config("notarium-test-shared", S3BucketModePolicy::DetectFromBucket);
        static SHARED_BUCKET_READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
        SHARED_BUCKET_READY
            .get_or_init(|| async {
                notarium_canonical::blobs::s3::admin_ensure_bucket(&s3_cfg, Some("Enabled"))
                    .await
                    .expect("ensure shared MinIO test bucket");
            })
            .await;
        s3_cfg.application_prefix = format!("{schema}/");
        self.pg_s3_config(installation_id, schema, s3_cfg)
    }

    pub fn fresh_s3_bucket(&self, prefix: &str) -> String {
        let mut bytes = [0u8; 6];
        getrandom::fill(&mut bytes).expect("CSPRNG available");
        format!("notarium-{prefix}-{}", hex::encode(bytes))
    }

    pub fn s3_config(&self, bucket: impl Into<String>, policy: S3BucketModePolicy) -> S3Config {
        S3Config {
            endpoint: self.s3_endpoint.clone(),
            region: self.s3_region.clone(),
            bucket: bucket.into(),
            application_prefix: String::new(),
            addressing: S3AddressingStyle::PathStyle,
            credentials: S3Credentials {
                access_key_id: self.s3_access_key.clone(),
                secret_access_key: self.s3_secret_key.clone(),
                session_token: None,
            },
            custom_ca_pem: None,
            unix_socket: Some(self.s3_socket.clone()),
            bucket_mode_policy: policy,
            request_timeout: Duration::from_secs(10),
        }
    }

    pub fn pg_s3_config(
        &self,
        installation_id: InstallationId,
        schema: &str,
        s3_cfg: S3Config,
    ) -> CanonicalConfig {
        CanonicalConfig {
            installation_id,
            sql: SqlBackendConfig::postgres_default(self.pg_connect_config(), schema),
            blobs: BlobBackendConfig::S3(Box::new(s3_cfg)),
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: notarium_canonical::config::default_postgres_backup_budget(),
        }
    }
}

pub struct TempDataRoot {
    path: PathBuf,
}

impl TempDataRoot {
    pub fn new(prefix: &str) -> Self {
        let mut bytes = [0u8; 12];
        getrandom::fill(&mut bytes).expect("CSPRNG available");
        let path = std::env::temp_dir().join(format!(
            "notarium-canonical-{prefix}-{}",
            hex::encode(bytes)
        ));
        fs::create_dir_all(&path).expect("create temporary DataRoot directory");
        Self { path }
    }

    pub fn data_root(&self) -> DataRoot {
        DataRoot::new(&self.path)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn open_raw_sqlite(&self) -> SqliteConnection {
        let opts = SqliteConnectOptions::new()
            .filename(self.data_root().canonical())
            .create_if_missing(false);
        SqliteConnection::connect_with(&opts)
            .await
            .expect("open raw SQLite canonical database")
    }
}

impl Drop for TempDataRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn random_bytes_16() -> [u8; 16] {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("CSPRNG available");
    b
}

pub fn sample_installation_id(seed: u8) -> InstallationId {
    InstallationId::from_bytes([seed; 16])
}

pub fn sample_space_id(seed: u8) -> SpaceId {
    SpaceId::from_bytes([seed; 16])
}

pub fn sample_incarnation(seed: u8) -> HistoryIncarnation {
    HistoryIncarnation::from_bytes([seed; 16])
}

pub fn sample_folder_id(seed: u8) -> FolderId {
    FolderId::from_bytes([seed; 16])
}

pub fn sample_note_id(seed: u8) -> NoteId {
    NoteId::from_bytes([seed; 16])
}

pub fn sample_revision_id(seed: u8) -> RevisionId {
    RevisionId::from_bytes([seed; 16])
}

pub fn sample_principal_id(seed: u8) -> PrincipalId {
    PrincipalId::from_bytes([seed; 16])
}

pub fn sample_run_id(seed: u8) -> AgentRunId {
    AgentRunId::from_bytes([seed; 16])
}

pub fn maintenance_ctx(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: CallBudget {
            request: RequestId::from_bytes(random_bytes_16()),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        },
    }
}

pub fn assert_validation_err<T: std::fmt::Debug>(
    result: &Result<T, notarium_core::error::PortError>,
    expected: notarium_core::error::ValidationReason,
) {
    match result {
        Err(notarium_core::error::PortError::Domain(
            notarium_core::DomainError::ValidationFailed { diagnostic },
        )) if diagnostic.reason == expected => {}
        other => panic!("expected ValidationFailed({expected:?}), got {other:?}"),
    }
}
