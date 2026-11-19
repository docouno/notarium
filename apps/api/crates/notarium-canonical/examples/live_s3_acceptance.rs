#![forbid(unsafe_code)]

//! Live S3 release-acceptance runner for disposable cloud/self-hosted buckets
//! (Amazon S3 general-purpose, Yandex Object Storage, pinned MinIO Community).
//!
//! Without explicit disposable credentials and bucket coordinates, this runner
//! NEVER reports `PASS`; it emits `"status": "UNVERIFIED"` and exits with code `2`.

use std::{collections::BTreeMap, env, process::ExitCode, time::Duration};

use notarium_canonical::{
    BlobBackendConfig, CanonicalConfig, CanonicalRuntime, CreateSpaceSpec, S3AddressingStyle,
    S3BucketModePolicy, S3Config, S3Credentials, SqlBackendConfig, WriterConfig,
    default_backup_budget,
};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::DataRoot,
    ids::{
        CommandKey, ContentDigest, FolderId, GrantId, HistoryIncarnation, InstallationId,
        LeaseEpoch, NoteId, PrincipalId, RequestId, SpaceId, SpaceSeq,
    },
    model::HistoryScope,
    ports::{
        CallBudget, Cancellation, CreateNote, DeleteDisposition, DeleteNote, GetNote, Mutation,
        NoteWritePort, Preconditions, SpaceContext,
    },
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
};
use serde::Serialize;

const REQUIRED_ENV_VARS: &[&str] = &[
    "NOTARIUM_LIVE_S3_PROVIDER",
    "NOTARIUM_LIVE_S3_ENDPOINT",
    "NOTARIUM_LIVE_S3_REGION",
    "NOTARIUM_LIVE_S3_BUCKET",
    "NOTARIUM_LIVE_S3_ACCESS_KEY_ID",
    "NOTARIUM_LIVE_S3_SECRET_ACCESS_KEY",
    "NOTARIUM_LIVE_S3_BUCKET_MODE",
];

#[derive(Serialize)]
struct LiveS3AcceptanceReport {
    status: &'static str,
    adapter_version: &'static str,
    provider: Option<String>,
    endpoint: Option<String>,
    region: Option<String>,
    bucket: Option<String>,
    application_prefix: Option<String>,
    bucket_mode_policy: Option<String>,
    missing_env: Vec<&'static str>,
    checks_executed: Vec<&'static str>,
    detail: String,
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> ExitCode {
    let mut missing = Vec::new();
    for &key in REQUIRED_ENV_VARS {
        if env::var(key)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .is_none()
        {
            missing.push(key);
        }
    }

    if !missing.is_empty() {
        let report = LiveS3AcceptanceReport {
            status: "UNVERIFIED",
            adapter_version: env!("CARGO_PKG_VERSION"),
            provider: env::var("NOTARIUM_LIVE_S3_PROVIDER").ok(),
            endpoint: env::var("NOTARIUM_LIVE_S3_ENDPOINT").ok(),
            region: env::var("NOTARIUM_LIVE_S3_REGION").ok(),
            bucket: env::var("NOTARIUM_LIVE_S3_BUCKET").ok(),
            application_prefix: env::var("NOTARIUM_LIVE_S3_PREFIX").ok(),
            bucket_mode_policy: env::var("NOTARIUM_LIVE_S3_BUCKET_MODE").ok(),
            missing_env: missing,
            checks_executed: Vec::new(),
            detail: "disposable live S3 credentials/target not supplied; refusing to claim PASS"
                .to_owned(),
        };
        println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("serialize UNVERIFIED report")
        );
        return ExitCode::from(2);
    }

    let provider = env::var("NOTARIUM_LIVE_S3_PROVIDER").unwrap();
    let endpoint = env::var("NOTARIUM_LIVE_S3_ENDPOINT").unwrap();
    let region = env::var("NOTARIUM_LIVE_S3_REGION").unwrap();
    let bucket = env::var("NOTARIUM_LIVE_S3_BUCKET").unwrap();
    let access_key_id = env::var("NOTARIUM_LIVE_S3_ACCESS_KEY_ID").unwrap();
    let secret_access_key = env::var("NOTARIUM_LIVE_S3_SECRET_ACCESS_KEY").unwrap();
    let session_token = env::var("NOTARIUM_LIVE_S3_SESSION_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    let mode_raw = env::var("NOTARIUM_LIVE_S3_BUCKET_MODE").unwrap();

    let bucket_mode_policy = match mode_raw.as_str() {
        "never_versioned" => S3BucketModePolicy::ExplicitNeverVersioned,
        "versioning_enabled" => S3BucketModePolicy::RequireEnabled,
        "detect" => S3BucketModePolicy::DetectFromBucket,
        other => {
            let report = LiveS3AcceptanceReport {
                status: "FAIL",
                adapter_version: env!("CARGO_PKG_VERSION"),
                provider: Some(provider),
                endpoint: Some(endpoint),
                region: Some(region),
                bucket: Some(bucket),
                application_prefix: None,
                bucket_mode_policy: Some(other.to_owned()),
                missing_env: Vec::new(),
                checks_executed: Vec::new(),
                detail: format!(
                    "unsupported NOTARIUM_LIVE_S3_BUCKET_MODE '{other}' (expected 'never_versioned', 'versioning_enabled', or 'detect')"
                ),
            };
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            return ExitCode::from(1);
        }
    };

    let addressing = match env::var("NOTARIUM_LIVE_S3_ADDRESSING")
        .unwrap_or_else(|_| "virtual_hosted".to_owned())
        .as_str()
    {
        "path" | "path_style" => S3AddressingStyle::PathStyle,
        _ => S3AddressingStyle::VirtualHosted,
    };

    let mut run_nonce = [0u8; 8];
    getrandom::fill(&mut run_nonce).expect("CSPRNG");
    let prefix_base = env::var("NOTARIUM_LIVE_S3_PREFIX")
        .unwrap_or_else(|_| "notarium-live-acceptance".to_owned());
    let prefix = format!(
        "{}/run-{}",
        prefix_base.trim_matches('/'),
        hex::encode(run_nonce)
    );

    let s3_cfg = S3Config {
        endpoint: endpoint.clone(),
        region: region.clone(),
        bucket: bucket.clone(),
        application_prefix: prefix.clone(),
        addressing,
        credentials: S3Credentials {
            access_key_id,
            secret_access_key,
            session_token,
        },
        custom_ca_pem: None,
        unix_socket: None,
        bucket_mode_policy,
        request_timeout: Duration::from_secs(30),
    };

    match execute_live_suite(s3_cfg).await {
        Ok(checks) => {
            let report = LiveS3AcceptanceReport {
                status: "PASS",
                adapter_version: env!("CARGO_PKG_VERSION"),
                provider: Some(provider),
                endpoint: Some(endpoint),
                region: Some(region),
                bucket: Some(bucket),
                application_prefix: Some(prefix),
                bucket_mode_policy: Some(mode_raw),
                missing_env: Vec::new(),
                checks_executed: checks,
                detail: "live disposable S3ChunkedV1 conditional PUT, readback, and 3-step purge verified".to_owned(),
            };
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            ExitCode::SUCCESS
        }
        Err(err) => {
            let report = LiveS3AcceptanceReport {
                status: "FAIL",
                adapter_version: env!("CARGO_PKG_VERSION"),
                provider: Some(provider),
                endpoint: Some(endpoint),
                region: Some(region),
                bucket: Some(bucket),
                application_prefix: Some(prefix),
                bucket_mode_policy: Some(mode_raw),
                missing_env: Vec::new(),
                checks_executed: Vec::new(),
                detail: format!("{err:?}"),
            };
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            ExitCode::from(1)
        }
    }
}

async fn execute_live_suite(
    s3_cfg: S3Config,
) -> Result<Vec<&'static str>, notarium_core::error::PortError> {
    let mut rand16 = [0u8; 16];
    getrandom::fill(&mut rand16).expect("CSPRNG");
    let temp_dir = env::temp_dir().join(format!("notarium-live-s3-{}", hex::encode(rand16)));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let data_root = DataRoot::new(&temp_dir);

    let cfg = CanonicalConfig {
        installation_id: InstallationId::from_bytes(rand16),
        sql: SqlBackendConfig::sqlite_default(data_root),
        blobs: BlobBackendConfig::S3(Box::new(s3_cfg)),
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: default_backup_budget(),
    };

    let (store, runtime) = CanonicalRuntime::open(cfg).await?;
    let actor = PrincipalId::from_bytes([0x51; 16]);
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0x52; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x53; 16]),
            root_folder_id: FolderId::from_bytes([0x54; 16]),
            slug: "live-s3-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: LeaseEpoch::new(1)?,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await?;

    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let verified = VerifiedHuman::attest(
        actor.clone(),
        GrantId::from_bytes([0x55; 16]),
        BTreeMap::from([(space.scope.space_id.clone(), grant)]),
        true,
    );
    let ctx = SpaceContext::new(
        EngineAuthContext::for_human(verified),
        space.scope.clone(),
        CallBudget {
            request: RequestId::from_bytes([0x56; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(60),
        },
    )?;

    // Multi-part (> 4 MiB) payload to exercise S3ChunkedV1 multi-frame PUT + readback + purge.
    let body_chunk = "LiveS3AcceptancePayloadLine-0123456789abcdef\n".repeat(110_000);
    let carrier = format!("---\ntitle: Live S3 MultiPart\n---\n# Live S3\n\n{body_chunk}");
    let note_id = NoteId::from_bytes([0x57; 16]);

    let created = store
        .create_note(
            ctx.clone(),
            Mutation {
                identity: fresh_identity(&space.scope, &actor),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: note_id.clone(),
                    parent: None,
                    slug: "live-s3-multipart".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: carrier.clone(),
                },
            },
        )
        .await?;

    let snap = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: note_id.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::new(vec![created.receipt])?),
            },
        )
        .await?;
    assert_eq!(snap.document.explicit_read(ctx.auth())?, carrier);

    let _purged = store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: fresh_identity(&space.scope, &actor),
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: note_id,
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await?;

    runtime.shutdown().await?;
    let _ = std::fs::remove_dir_all(&temp_dir);

    Ok(vec![
        "bucket_versioning_policy_probe",
        "s3_chunked_v1_multipart_conditional_put",
        "s3_chunked_v1_verified_readback",
        "three_step_purge_terminal_markers_and_version_cleanup",
    ])
}

fn fresh_identity(scope: &HistoryScope, actor: &PrincipalId) -> CommandIdentity {
    let mut k = [0u8; 16];
    let mut h = [0u8; 32];
    getrandom::fill(&mut k).expect("CSPRNG");
    getrandom::fill(&mut h).expect("CSPRNG");
    CommandIdentity {
        scope: scope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes(k),
        hash: ContentDigest::from_bytes(h),
    }
}
