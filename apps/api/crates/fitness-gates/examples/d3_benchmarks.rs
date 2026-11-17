#![forbid(unsafe_code)]

//! Attributed `--release` D3 canonical storage & CAS benchmark suite.
//!
//! Run with the checkout fixture launcher for a tree-attributed JSON report.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use notarium_canonical::{
    BlobBackendConfig, CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec,
    CreateSpaceSpec, PgConnectConfig, PgTransport, S3AddressingStyle, S3BucketModePolicy, S3Config,
    S3Credentials, SqlBackendConfig, WriterConfig, blobs::s3::admin_ensure_bucket,
    build_pg_connect_options, default_backup_budget,
};
use notarium_control::{
    backup::{BackupConfig, ControlBackup},
    keyring::{FreshLocalInitializer, Keyring, KeyringLocation},
    store::{ControlStore, PostgresConfig},
};
use notarium_core::{
    auth::{ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::{DataRoot, EpochClassification, EpochReason, StorageEpochState},
    ids::{
        AgentRunId, BackupId, ChatThreadId, CommandKey, ContentDigest, FolderId, GrantId,
        HistoryIncarnation, InstallationId, LeaseEpoch, NoteId, PrincipalId, RequestId, RevisionId,
        SpaceId, SpaceSeq, ThreadEntrySeq, ViewKey,
    },
    model::HistoryScope,
    patch::{CarrierEditOrigin, CarrierPatchPlan, CarrierSplice},
    ports::{
        AppendChat, BackupParticipantPort, BoardGroupFieldKind, BoardMoveFacts, BoardMoveFactsSpec,
        BoardMutationFactsProvider, BoardPlannerAuthority, CallBudget, Cancellation, ChatEntryKind,
        ChatInputBody, ChatPort, ChatRead, ChatThreadKind, CreateChat, CreateNote,
        DeleteDisposition, DeleteNote, EditNote, EmptyRootAuthorization, EvaluatedBoardGroup,
        EvaluatedBoardRow, ForkChat, GetNote, GroupKey, MaintenanceContext, MoveBoardCard,
        MoveFolder, Mutation, NoteRevision, NoteWritePort, PageLimit, PortFuture, Preconditions,
        RankExpectation, RankNeighbor, RollbackAgentRun, RollbackBoardFacts,
        RollbackBoardFactsRequest, SemanticPlacement, ServiceAuthority, ServicePurpose,
        SpaceContext, ViewRef,
    },
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
    span::{ByteSpan, CarrierByteSpan, CarrierUtf16Span, Utf16Span},
    value::ScalarValue,
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, PgConnection};

const CARRIER_TARGET_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
struct RawFixtureManifest {
    run_id: String,
    pg_socket_dir_container: String,
    pg_socket_dir_host: String,
    pg_port: u16,
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
struct BenchFixtures {
    run_id: String,
    pg_socket_dir: PathBuf,
    pg_port: u16,
    pg_user: String,
    pg_password: String,
    pg_database: String,
    s3_socket: PathBuf,
    s3_endpoint: String,
    s3_region: String,
    s3_access_key: String,
    s3_secret_key: String,
    minio_source_commit: String,
    minio_release_tag: String,
}

impl BenchFixtures {
    fn load_required(repo_root: &Path) -> Self {
        let container_manifest = Path::new("/workspace/.artifacts/storage-tests/current.json");
        let host_manifest = repo_root.join(".artifacts/storage-tests/current.json");
        let manifest_path = if let Some(exp) = env::var_os("NOTARIUM_STORAGE_FIXTURES_MANIFEST") {
            PathBuf::from(exp)
        } else if container_manifest.exists() {
            container_manifest.to_path_buf()
        } else if host_manifest.exists() {
            host_manifest
        } else {
            panic!(
                "offline PostgreSQL 16 + MinIO CE fixtures not found (missing {}); run via with-storage-fixtures.sh",
                host_manifest.display()
            );
        };
        let bytes = fs::read(&manifest_path).expect("read fixture manifest");
        let raw: RawFixtureManifest =
            serde_json::from_slice(&bytes).expect("parse fixture manifest");

        let pg_sock = format!(".s.PGSQL.{}", raw.pg_port);
        let pg_c = PathBuf::from(&raw.pg_socket_dir_container);
        let pg_h = PathBuf::from(&raw.pg_socket_dir_host);
        let pg_socket_dir = if pg_c.join(&pg_sock).exists() {
            pg_c
        } else if pg_h.join(&pg_sock).exists() {
            pg_h
        } else {
            panic!("PostgreSQL UDS socket missing");
        };

        let s3_c = PathBuf::from(&raw.s3_socket_container);
        let s3_h = PathBuf::from(&raw.s3_socket_host);
        let s3_socket = if s3_c.exists() {
            s3_c
        } else if s3_h.exists() {
            s3_h
        } else {
            panic!("MinIO CE UDS socket missing");
        };

        Self {
            run_id: raw.run_id,
            pg_socket_dir,
            pg_port: raw.pg_port,
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

    fn pg_connect(&self) -> PgConnectConfig {
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

    async fn open_raw_pg(&self) -> PgConnection {
        let opts = build_pg_connect_options(&self.pg_connect());
        PgConnection::connect_with(&opts)
            .await
            .expect("open raw PG16 connection")
    }

    async fn drop_pg_schema(&self, schema: &str) {
        let mut conn = self.open_raw_pg().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
        )))
        .execute(&mut conn)
        .await
        .expect("drop PG schema");
        let _ = conn.close().await;
    }

    fn fresh_pg_schema(&self, tag: &str) -> String {
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        format!("test_b_{tag}_{}", hex::encode(b))
    }

    fn fresh_s3_bucket(&self, tag: &str) -> String {
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        format!("notarium-bench-{tag}-{}", hex::encode(b))
    }

    fn s3_config(&self, bucket: String) -> S3Config {
        S3Config {
            endpoint: self.s3_endpoint.clone(),
            region: self.s3_region.clone(),
            bucket,
            application_prefix: String::new(),
            addressing: S3AddressingStyle::PathStyle,
            credentials: S3Credentials {
                access_key_id: self.s3_access_key.clone(),
                secret_access_key: self.s3_secret_key.clone(),
                session_token: None,
            },
            custom_ca_pem: None,
            unix_socket: Some(self.s3_socket.clone()),
            bucket_mode_policy: S3BucketModePolicy::RequireEnabled,
            request_timeout: Duration::from_secs(15),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct PercentilesUs {
    samples: usize,
    min_us: f64,
    p50_us: f64,
    p95_us: f64,
    p99_us: f64,
    max_us: f64,
    mean_us: f64,
}

fn compute_percentiles_from_ns(mut samples_ns: Vec<u64>) -> PercentilesUs {
    assert!(
        !samples_ns.is_empty(),
        "percentile sample vector must not be empty"
    );
    samples_ns.sort_unstable();
    let n = samples_ns.len();
    let pct = |q: f64| -> f64 {
        let rank = ((n as f64) * q).ceil() as usize;
        let idx = rank.saturating_sub(1).min(n - 1);
        (samples_ns[idx] as f64) / 1_000.0
    };
    let sum_ns: u128 = samples_ns.iter().map(|&v| u128::from(v)).sum();
    PercentilesUs {
        samples: n,
        min_us: (samples_ns[0] as f64) / 1_000.0,
        p50_us: pct(0.50),
        p95_us: pct(0.95),
        p99_us: pct(0.99),
        max_us: (samples_ns[n - 1] as f64) / 1_000.0,
        mean_us: ((sum_ns as f64) / (n as f64)) / 1_000.0,
    }
}

#[derive(Clone, Debug, Serialize)]
struct EnvironmentAttribution {
    generated_at_unix_s: u64,
    rust_profile: &'static str,
    git_base_commit: String,
    git_commit: Option<String>,
    git_tree: String,
    fixture_launcher_cpu_max: String,
    fixture_launcher_memory_max: String,
    cgroup_cpu_max: String,
    cgroup_memory_max: String,
    available_parallelism: usize,
    kernel_release: String,
    work_dir: String,
    filesystem_type: String,
    filesystem_mount_point: String,
    sqlite_wal_soft_watermark_bytes: u64,
    sqlite_wal_high_watermark_bytes: u64,
    postgres_transport: &'static str,
    postgres_synchronous_commit: String,
    postgres_select_one_rtt: PercentilesUs,
    s3_transport: &'static str,
    writer_max_batch_items: usize,
    writer_carrier_bytes: usize,
    cache_warmth_policy: &'static str,
    fixture_run_id: String,
    minio_release_tag: String,
    minio_source_commit: String,
    smoke_mode: bool,
}

#[derive(Clone, Debug, Serialize)]
struct WriterRunMetrics {
    run_index: usize,
    concurrent_writers: usize,
    concurrent_readers: usize,
    warmup_secs: u64,
    measured_secs: f64,
    measured_mutations: u64,
    unique_carrier_digests: usize,
    measured_reads_completed: u64,
    sqlite_writer_synchronous: i64,
    sqlite_writer_journal_limit_before: i64,
    sqlite_writer_journal_limit_after: i64,
    max_reset_reader_gate_ns: u64,
    reset_gate_overruns: u64,
    throughput_mut_per_sec: f64,
    leaked_sqlite_busy: u64,
    writer_errors: u64,
    reader_errors: u64,
    admission_to_receipt: PercentilesUs,
    phase2_batch_commit: PercentilesUs,
    phase2_batch_count: usize,
    mean_batch_items: f64,
}

#[derive(Clone, Debug, Serialize)]
struct RollbackProfileMetrics {
    backend: &'static str,
    iterations: usize,
    enforce_5ms_budget: bool,
    restored_per_call: usize,
    trashed_per_call: usize,
    skipped_manual_per_call: usize,
    latency: PercentilesUs,
}

#[derive(Clone, Debug, Serialize)]
struct ChatReadProfileMetrics {
    backend: &'static str,
    topology: &'static str,
    seeded_turns: usize,
    window_entries: usize,
    measured_reads: usize,
    sql_writes_during_reads: u64,
    latency: PercentilesUs,
}

#[derive(Clone, Debug, Serialize)]
struct BoardFirstSlotMetrics {
    backend: &'static str,
    moves_executed: usize,
    max_rank_bytes_observed: usize,
    pma_rebalance_events: usize,
    max_overlays_changed_in_single_move: usize,
    mean_overlays_changed_per_move: f64,
    latency: PercentilesUs,
}

#[derive(Clone, Debug, Serialize)]
struct FolderMoveMetrics {
    backend: &'static str,
    seeded_descendant_folders: usize,
    seeded_descendant_notes: usize,
    total_seeded_descendants: usize,
    moves_executed: usize,
    descendant_rows_modified: u64,
    latency: PercentilesUs,
}

#[derive(Clone, Debug, Serialize)]
struct PairedBackupPauseMetrics {
    backend: &'static str,
    canonical_spaces: usize,
    drain_latency: PercentilesUs,
    confirmed_pause_latency: PercentilesUs,
    prepare_and_hold_latency: PercentilesUs,
    captures: usize,
    pause_latency: PercentilesUs,
}

#[derive(Clone, Debug, Serialize)]
struct D3BenchmarkReport {
    status: &'static str,
    environment: EnvironmentAttribution,
    writer_50w_0r_runs: Vec<WriterRunMetrics>,
    writer_50w_200r_runs: Vec<WriterRunMetrics>,
    rollback_profiles: Vec<RollbackProfileMetrics>,
    chat_read_profiles: Vec<ChatReadProfileMetrics>,
    board_first_slot_profiles: Vec<BoardFirstSlotMetrics>,
    folder_move_profiles: Vec<FolderMoveMetrics>,
    paired_backup_pause_profiles: Vec<PairedBackupPauseMetrics>,
}

// ============================================================================
// Common helpers
// ============================================================================

fn fill_buffered_rng(dst: &mut [u8]) {
    struct RngBuf {
        buf: [u8; 512],
        pos: usize,
    }
    thread_local! {
        static RNG: std::cell::RefCell<RngBuf> = const {
            std::cell::RefCell::new(RngBuf {
                buf: [0u8; 512],
                pos: 512,
            })
        };
    }
    RNG.with(|cell| {
        let mut r = cell.borrow_mut();
        let mut written = 0usize;
        while written < dst.len() {
            if r.pos >= r.buf.len() {
                getrandom::fill(&mut r.buf).unwrap();
                r.pos = 0;
            }
            let avail = r.buf.len() - r.pos;
            let take = avail.min(dst.len() - written);
            dst[written..written + take].copy_from_slice(&r.buf[r.pos..r.pos + take]);
            r.pos += take;
            written += take;
        }
    });
}

fn random_16() -> [u8; 16] {
    let mut b = [0u8; 16];
    fill_buffered_rng(&mut b);
    b
}

fn make_budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(random_16()),
        remaining: Duration::from_secs(30),
        cancellation: Cancellation::default(),
    }
}

fn maintenance_ctx(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: make_budget(),
    }
}

fn build_owner_auth(scope: &HistoryScope, principal: PrincipalId) -> EngineAuthContext {
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let verified = VerifiedHuman::attest(
        principal,
        GrantId::from_bytes([7u8; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        true,
    );
    EngineAuthContext::for_human(verified)
}

fn fast_space_ctx(auth: &EngineAuthContext, scope: &HistoryScope) -> SpaceContext {
    SpaceContext::new(auth.clone(), scope.clone(), make_budget()).expect("owner SpaceContext")
}

fn owner_ctx(scope: &HistoryScope, principal: PrincipalId) -> SpaceContext {
    let auth = build_owner_auth(scope, principal);
    fast_space_ctx(&auth, scope)
}

fn agent_run_ctx(base_human: &SpaceContext, run: AgentRunId) -> SpaceContext {
    let auth = base_human
        .auth()
        .for_agent_run(
            run,
            base_human.scope().space_id.clone(),
            ChatAudience::Personal,
            base_human.auth().spaces().clone(),
        )
        .expect("for_agent_run");
    SpaceContext::new(auth, base_human.scope().clone(), make_budget()).expect("run SpaceContext")
}

fn ordered_16() -> [u8; 16] {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut b = [0u8; 16];
    fill_buffered_rng(&mut b[8..16]);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let ms_be = ms.to_be_bytes();
    b[0..6].copy_from_slice(&ms_be[2..8]);
    let s = (SEQ.fetch_add(1, Ordering::Relaxed) as u16).to_be_bytes();
    b[6..8].copy_from_slice(&s);
    b
}

fn next_mutation<T>(scope: &HistoryScope, actor: &PrincipalId, input: T) -> Mutation<T> {
    let kb = ordered_16();
    Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes(kb),
            hash: ContentDigest::from_bytes(*blake3::hash(&kb).as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

/// Builds a valid UTF-8 Markdown document of EXACTLY `CARRIER_TARGET_BYTES` (`4096` bytes)
/// whose BLAKE3 digest is uniquely determined by `(worker_id, seq_num)`.
fn build_unique_4kib_carrier(header: &str, worker_id: usize, seq_num: u64) -> (String, String) {
    assert!(header.len() < CARRIER_TARGET_BYTES - 128);
    let body_target = CARRIER_TARGET_BYTES - header.len();
    let mut body = format!("# Benchmark Note w{worker_id} s{seq_num}\n\n");
    let mut xof = blake3::Hasher::new();
    xof.update(b"notarium-d3-4kib-carrier-v1:");
    xof.update(&(worker_id as u64).to_le_bytes());
    xof.update(&seq_num.to_le_bytes());
    let mut reader = xof.finalize_xof();

    // Emit deterministic pseudo-random ASCII hex lines without intermediate String heap allocations.
    const HEX_LUT: &[u8; 16] = b"0123456789abcdef";
    let mut raw_chunk = [0u8; 32];
    let mut hex_line = [0u8; 65];
    hex_line[64] = b'\n';
    body.reserve(body_target);
    while body.len() + 66 <= body_target {
        reader.fill(&mut raw_chunk);
        for (i, &byte) in raw_chunk.iter().enumerate() {
            hex_line[i * 2] = HEX_LUT[usize::from(byte >> 4)];
            hex_line[i * 2 + 1] = HEX_LUT[usize::from(byte & 0x0f)];
        }
        let line_str = std::str::from_utf8(&hex_line).expect("ASCII hex");
        body.push_str(line_str);
    }
    while body.len() + 1 < body_target {
        body.push('x');
    }
    if body.len() < body_target {
        body.push('\n');
    }
    assert_eq!(header.len() + body.len(), CARRIER_TARGET_BYTES);
    let mut full = String::with_capacity(CARRIER_TARGET_BYTES);
    full.push_str(header);
    full.push_str(&body);
    assert_eq!(full.len(), CARRIER_TARGET_BYTES);
    (full, body)
}

fn verify_non_tmpfs_mount(path: &Path) -> (String, String) {
    let canonical = fs::canonicalize(path).expect("canonicalize benchmark work dir");
    let canonical_str = canonical.to_string_lossy();
    let mounts = fs::read_to_string("/proc/mounts").expect("read /proc/mounts");

    let mut best_mount = String::new();
    let mut best_fstype = String::new();
    for line in mounts.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let mnt = parts[1].replace("\\040", " ");
        let fstype = parts[2];
        let matches = if mnt == "/" {
            true
        } else {
            canonical_str.as_ref() == mnt || canonical_str.starts_with(&format!("{mnt}/"))
        };
        if matches && mnt.len() >= best_mount.len() {
            best_mount = mnt;
            best_fstype = fstype.to_owned();
        }
    }
    assert!(
        !best_fstype.is_empty(),
        "failed resolving filesystem mount for {}",
        canonical.display()
    );
    assert!(
        best_fstype != "tmpfs" && best_fstype != "ramfs",
        "D3 benchmark work directory '{}' resolves to forbidden in-memory filesystem '{}' (mount '{}')",
        canonical.display(),
        best_fstype,
        best_mount
    );
    (best_fstype, best_mount)
}

fn read_trimmed_or_unknown(path: &str) -> String {
    fs::read_to_string(path)
        .map(|s| s.trim().to_owned())
        .unwrap_or_else(|_| "unknown".to_owned())
}

// ============================================================================
// Suite 1: Writer (`> 2000 mut/s`, `0` leaked `SQLITE_BUSY`)
// ============================================================================

async fn run_writer_benchmark_case(
    work_root: &Path,
    run_index: usize,
    concurrent_writers: usize,
    concurrent_readers: usize,
    warmup_dur: Duration,
    measure_dur: Duration,
) -> WriterRunMetrics {
    let run_dir = work_root.join(format!(
        "writer-r{run_index}-w{concurrent_writers}-rd{concurrent_readers}"
    ));
    let _ = fs::remove_dir_all(&run_dir);
    fs::create_dir_all(&run_dir).unwrap();

    let data_root = DataRoot::new(&run_dir);
    let cfg = CanonicalConfig {
        installation_id: InstallationId::from_bytes([0x10 + (run_index as u8); 16]),
        sql: SqlBackendConfig::sqlite_default(data_root.clone()),
        blobs: BlobBackendConfig::Local { data_root },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: default_backup_budget(),
    };
    let (store, runtime) = CanonicalRuntime::open(cfg)
        .await
        .expect("open writer store");

    let (sync_pragma, journal_limit_before) =
        store.sqlite_writer_pragmas_for_bench().await.unwrap();
    assert_eq!(
        sync_pragma, 2,
        "SQLite writer must run at synchronous=FULL (2)"
    );

    let actor = PrincipalId::from_bytes([0x11; 16]);
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0x12; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x13; 16]),
            root_folder_id: FolderId::from_bytes([0x14; 16]),
            slug: "d3-writer-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let base_ctx = owner_ctx(&space.scope, actor.clone());

    // Seed one private 4 KiB note per writer so all 50 writers commit unique 4 KiB edits concurrently
    // without artificial cross-writer revision conflicts or receipt replays.
    let mut writer_notes = Vec::with_capacity(concurrent_writers);
    for w in 0..concurrent_writers {
        let mut nb = [0u8; 16];
        nb[0] = 0x20;
        nb[8..16].copy_from_slice(&(w as u64).to_be_bytes());
        let nid = NoteId::from_bytes(nb);
        let header = format!("---\ntitle: Writer Note {w}\n---\n");
        let (carrier, _body) = build_unique_4kib_carrier(&header, w, 0);
        store
            .create_note(
                base_ctx.clone(),
                next_mutation(
                    &space.scope,
                    &actor,
                    CreateNote {
                        note: nid.clone(),
                        parent: None,
                        slug: format!("writer-note-{w}"),
                        class: DocClass::UserDoc,
                        carrier: carrier.clone(),
                    },
                ),
            )
            .await
            .unwrap();
        writer_notes.push((nid, header, carrier));
    }

    let note_ids_only: Arc<Vec<NoteId>> =
        Arc::new(writer_notes.iter().map(|(n, _, _)| n.clone()).collect());
    let shared_auth = build_owner_auth(&space.scope, actor.clone());

    let phase = Arc::new(AtomicU64::new(0)); // 0 = warmup, 1 = measure, 2 = stop
    let writer_errors = Arc::new(AtomicU64::new(0));
    let first_writer_err: Arc<std::sync::OnceLock<String>> = Arc::new(std::sync::OnceLock::new());
    let reader_errors = Arc::new(AtomicU64::new(0));
    let measured_reads = Arc::new(AtomicU64::new(0));

    let mut reader_handles = Vec::with_capacity(concurrent_readers);
    for r in 0..concurrent_readers {
        let store_cl = store.clone();
        let scope_cl = space.scope.clone();
        let auth_cl = shared_auth.clone();
        let notes_cl = Arc::clone(&note_ids_only);
        let phase_cl = Arc::clone(&phase);
        let r_errs = Arc::clone(&reader_errors);
        let m_reads = Arc::clone(&measured_reads);
        reader_handles.push(tokio::spawn(async move {
            let mut idx = r % notes_cl.len();
            while phase_cl.load(Ordering::Relaxed) != 2 {
                let nid = notes_cl[idx].clone();
                idx = (idx + 1) % notes_cl.len();
                let ctx = fast_space_ctx(&auth_cl, &scope_cl);
                match store_cl
                    .get_note(
                        ctx,
                        GetNote {
                            note: nid,
                            revision: None,
                            causal: CausalBasis::Exact(ReceiptSet::default()),
                        },
                    )
                    .await
                {
                    Ok(snap) => {
                        let _ = snap.document.metadata().revision();
                        if phase_cl.load(Ordering::Relaxed) == 1 {
                            m_reads.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Err(_) => {
                        r_errs.fetch_add(1, Ordering::Relaxed);
                    }
                }
                tokio::task::yield_now().await;
            }
        }));
    }

    let mut writer_handles = Vec::with_capacity(concurrent_writers);
    for (w, (nid, header, initial_carrier)) in writer_notes.into_iter().enumerate() {
        let store_cl = store.clone();
        let scope_cl = space.scope.clone();
        let actor_cl = actor.clone();
        let auth_cl = shared_auth.clone();
        let phase_cl = Arc::clone(&phase);
        let w_errs = Arc::clone(&writer_errors);
        let first_w_err = Arc::clone(&first_writer_err);
        writer_handles.push(tokio::spawn(async move {
            let mut cur_carrier = initial_carrier;
            let mut cur_digest =
                ContentDigest::from_bytes(*blake3::hash(cur_carrier.as_bytes()).as_bytes());
            let mut seq_num = 1u64;
            let mut local_latencies_ns = Vec::with_capacity(4096);
            let mut local_digests = Vec::with_capacity(4096);

            while phase_cl.load(Ordering::Relaxed) != 2 {
                let (next_carrier, next_body) = build_unique_4kib_carrier(&header, w, seq_num);
                seq_num += 1;
                let next_digest_bytes = *blake3::hash(next_carrier.as_bytes()).as_bytes();
                let body_span =
                    ByteSpan::new(header.len(), cur_carrier.len()).expect("valid body span");
                let utf16_span =
                    Utf16Span::new(header.len(), cur_carrier.len()).expect("valid utf16 span");
                let rep_len = next_body.len();
                let plan = CarrierPatchPlan {
                    base_content_hash: cur_digest,
                    body_range: body_span,
                    edits: vec![CarrierSplice {
                        origin: CarrierEditOrigin::Body,
                        bytes: CarrierByteSpan(body_span),
                        utf16: CarrierUtf16Span(utf16_span),
                        replacement: next_body,
                        replacement_utf16_len: rep_len,
                    }],
                };
                let ctx = fast_space_ctx(&auth_cl, &scope_cl);
                let mutation = next_mutation(
                    &scope_cl,
                    &actor_cl,
                    EditNote {
                        note: nid.clone(),
                        plan,
                    },
                );

                let in_measure_before = phase_cl.load(Ordering::Acquire) == 1;
                let t0 = Instant::now();
                match store_cl.edit_note(ctx, mutation).await {
                    Ok(_committed) => {
                        let elapsed_ns = u64::try_from(t0.elapsed().as_nanos()).unwrap_or(u64::MAX);
                        let in_measure_after = phase_cl.load(Ordering::Acquire) == 1;
                        if in_measure_before && in_measure_after {
                            local_latencies_ns.push(elapsed_ns);
                            local_digests.push(next_digest_bytes);
                        }
                        cur_carrier = next_carrier;
                        cur_digest = ContentDigest::from_bytes(next_digest_bytes);
                    }
                    Err(err) => {
                        let _ = first_w_err.set(format!("{err:?}"));
                        w_errs.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            (local_latencies_ns, local_digests)
        }));
    }

    // Warmup window
    tokio::time::sleep(warmup_dur).await;

    // Enable Phase-2 batch telemetry and enter measured window!
    store.set_writer_batch_telemetry(true).unwrap();
    let measure_started = Instant::now();
    phase.store(1, Ordering::Release);

    tokio::time::sleep(measure_dur).await;

    phase.store(2, Ordering::Release);
    let measured_secs = measure_started.elapsed().as_secs_f64();
    store.set_writer_batch_telemetry(false).unwrap();
    let batch_samples = store.take_writer_batch_samples().unwrap();

    let mut all_latencies_ns = Vec::new();
    let mut unique_digests = BTreeSet::new();
    for jh in writer_handles {
        let (lats, digests) = jh.await.unwrap();
        all_latencies_ns.extend(lats);
        for d in digests {
            unique_digests.insert(d);
        }
    }
    for jh in reader_handles {
        jh.await.expect("join the mixed-profile reader");
    }

    let (_, journal_limit_after) = store.sqlite_writer_pragmas_for_bench().await.unwrap();
    let wal_telem = store.wal_telemetry().expect("SQLite WAL telemetry");
    let leaked_busy = wal_telem.leaked_sqlite_busy_errors;
    let w_err_count = writer_errors.load(Ordering::SeqCst);
    let r_err_count = reader_errors.load(Ordering::SeqCst);
    let measured_reads_completed = measured_reads.load(Ordering::SeqCst);
    assert!(concurrent_readers == 0 || measured_reads_completed > 0);
    let measured_mutations = all_latencies_ns.len() as u64;
    let throughput = (measured_mutations as f64) / measured_secs;

    let batch_lat_ns: Vec<u64> = batch_samples.iter().map(|&(ns, _)| ns).collect();
    let total_batch_items: u64 = batch_samples.iter().map(|&(_, n)| u64::from(n)).sum();
    let mean_batch_items = if batch_samples.is_empty() {
        0.0
    } else {
        (total_batch_items as f64) / (batch_samples.len() as f64)
    };

    assert_eq!(
        w_err_count,
        0,
        "D3 gate failed: writer errors > 0 (first={:?})",
        first_writer_err.get()
    );
    assert_eq!(r_err_count, 0, "D3 gate failed: reader errors > 0");

    let admission_pct = compute_percentiles_from_ns(all_latencies_ns);
    let phase2_pct = compute_percentiles_from_ns(batch_lat_ns);

    drop(store);
    runtime.shutdown().await.unwrap();
    fs::remove_dir_all(run_dir).expect("remove completed writer fixture");

    assert_eq!(leaked_busy, 0, "D3 gate failed: leaked SQLITE_BUSY > 0");
    assert_eq!(w_err_count, 0, "D3 gate failed: writer errors > 0");
    assert_eq!(r_err_count, 0, "D3 gate failed: reader errors > 0");
    assert_eq!(
        unique_digests.len(),
        measured_mutations as usize,
        "every measured mutation must carry a unique 4 KiB digest (zero receipt replays)"
    );
    WriterRunMetrics {
        run_index,
        concurrent_writers,
        concurrent_readers,
        warmup_secs: warmup_dur.as_secs(),
        measured_secs,
        measured_mutations,
        unique_carrier_digests: unique_digests.len(),
        measured_reads_completed,
        sqlite_writer_synchronous: sync_pragma,
        sqlite_writer_journal_limit_before: journal_limit_before,
        sqlite_writer_journal_limit_after: journal_limit_after,
        max_reset_reader_gate_ns: wal_telem.max_reset_reader_gate_ns,
        reset_gate_overruns: wal_telem.reset_gate_overruns,
        throughput_mut_per_sec: throughput,
        leaked_sqlite_busy: leaked_busy,
        writer_errors: w_err_count,
        reader_errors: r_err_count,
        admission_to_receipt: admission_pct,
        phase2_batch_commit: phase2_pct,
        phase2_batch_count: batch_samples.len(),
        mean_batch_items,
    }
}

// ============================================================================
// Suite 2: Rollback Microfixture (`p95 < 5 ms` on SQLite+Local & PG16+Local)
// ============================================================================

struct PreparedRollbackTemplate {
    scope: HistoryScope,
    owner: PrincipalId,
    run_id: AgentRunId,
    expected_run_rev: RevisionId,
    expected_entities: Vec<NoteRevision>,
    warm_note: NoteId,
}

/// Seeds the exact D3 rollback microfixture:
/// - 18 pre-existing 4 KiB notes edited by `run_id` (note 0 edited 3x, note 17 then manually edited by human)
/// - 2 4 KiB notes created by `run_id`
/// - 1 pre-existing 4 KiB note trashed by `run_id` with subsequent slug collision created by human
async fn seed_rollback_microfixture(store: &CanonicalStore) -> PreparedRollbackTemplate {
    let owner = PrincipalId::from_bytes([0x31; 16]);
    let other_human = PrincipalId::from_bytes([0x32; 16]);
    let run_id = AgentRunId::from_bytes(random_16());

    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes(random_16()),
            incarnation: HistoryIncarnation::from_bytes(random_16()),
            root_folder_id: FolderId::from_bytes(random_16()),
            slug: format!("rollback-{}", hex::encode(random_16())),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();

    let human_ctx = owner_ctx(&space.scope, owner.clone());
    let foreign_ctx = owner_ctx(&space.scope, other_human.clone());
    let run_ctx = agent_run_ctx(&human_ctx, run_id.clone());

    let mut expected_entities = Vec::new();

    // 18 pre-existing notes
    let mut edited_notes = Vec::with_capacity(18);
    for i in 0..18usize {
        let mut nb = [0u8; 16];
        nb[0] = 0x40;
        nb[15] = i as u8;
        let nid = NoteId::from_bytes(nb);
        let header = format!("---\ntitle: Pre Note {i}\n---\n");
        let (carrier_v0, _) = build_unique_4kib_carrier(&header, 100 + i, 0);
        store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &space.scope,
                    &owner,
                    CreateNote {
                        note: nid.clone(),
                        parent: None,
                        slug: format!("pre-note-{i}"),
                        class: DocClass::UserDoc,
                        carrier: carrier_v0.clone(),
                    },
                ),
            )
            .await
            .unwrap();
        edited_notes.push((nid, header, carrier_v0));
    }

    // 1 pre-existing note that `run_id` will Trash and then collide with via a run-created note on slug
    let deleted_nid = NoteId::from_bytes([0x41; 16]);
    let del_header = "---\ntitle: Colliding Target\n---\n";
    let (del_v0, _) = build_unique_4kib_carrier(del_header, 200, 0);
    store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &space.scope,
                &owner,
                CreateNote {
                    note: deleted_nid.clone(),
                    parent: None,
                    slug: "colliding-target".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: del_v0,
                },
            ),
        )
        .await
        .unwrap();

    // Agent run edits the 18 notes (note 0 edited 3x; notes 1..18 edited 1x)
    for (i, (nid, header, cur_carrier)) in edited_notes.iter_mut().enumerate() {
        let passes = if i == 0 { 3usize } else { 1usize };
        let mut latest_rev = None;
        for p in 1..=passes {
            let (next_c, next_b) = build_unique_4kib_carrier(header, 100 + i, p as u64);
            let span = ByteSpan::new(header.len(), cur_carrier.len()).unwrap();
            let plan = notarium_syntax::patch::plan(
                cur_carrier,
                span,
                vec![(CarrierEditOrigin::Body, span, next_b)],
            )
            .unwrap();
            let ed = store
                .edit_note(
                    run_ctx.clone(),
                    next_mutation(
                        &space.scope,
                        &owner,
                        EditNote {
                            note: nid.clone(),
                            plan,
                        },
                    ),
                )
                .await
                .unwrap();
            *cur_carrier = next_c;
            latest_rev = Some(ed.value.revision);
        }
        if i == 17 {
            // Subsequent manual human edit on note 17 -> skipped_manual_edits!
            let (_manual_c, manual_b) = build_unique_4kib_carrier(header, 999, 99);
            let span = ByteSpan::new(header.len(), cur_carrier.len()).unwrap();
            let plan = notarium_syntax::patch::plan(
                cur_carrier,
                span,
                vec![(CarrierEditOrigin::Body, span, manual_b)],
            )
            .unwrap();
            let man_ed = store
                .edit_note(
                    foreign_ctx.clone(),
                    next_mutation(
                        &space.scope,
                        &other_human,
                        EditNote {
                            note: nid.clone(),
                            plan,
                        },
                    ),
                )
                .await
                .unwrap();
            expected_entities.push(NoteRevision {
                note: nid.clone(),
                revision: man_ed.value.revision,
            });
        } else {
            expected_entities.push(NoteRevision {
                note: nid.clone(),
                revision: latest_rev.unwrap(),
            });
        }
    }

    // Agent run trashes `deleted_nid` (`slug = "colliding-target"`) first...
    let trashed = store
        .delete_note(
            run_ctx.clone(),
            next_mutation(
                &space.scope,
                &owner,
                DeleteNote {
                    note: deleted_nid.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    expected_entities.push(NoteRevision {
        note: deleted_nid,
        revision: trashed.value.revision,
    });

    // ...and then creates 2 new 4 KiB notes, with `c == 0` occupying `slug = "colliding-target"`
    // so rollback must trash run-created notes before restoring `deleted_nid` at its original slug.
    for c in 0..2usize {
        let mut nb = [0u8; 16];
        nb[0] = 0x42;
        nb[15] = c as u8;
        let nid = NoteId::from_bytes(nb);
        let header = format!("---\ntitle: Created By Run {c}\n---\n");
        let (carrier, _) = build_unique_4kib_carrier(&header, 300 + c, 1);
        let slug = if c == 0 {
            "colliding-target".to_owned()
        } else {
            format!("run-created-{c}")
        };
        let cr = store
            .create_note(
                run_ctx.clone(),
                next_mutation(
                    &space.scope,
                    &owner,
                    CreateNote {
                        note: nid.clone(),
                        parent: None,
                        slug,
                        class: DocClass::UserDoc,
                        carrier,
                    },
                ),
            )
            .await
            .unwrap();
        expected_entities.push(NoteRevision {
            note: nid,
            revision: cr.value.revision,
        });
    }

    let expected_run_rev = store
        .inspect_agent_run_revision_for_test(&space.scope.space_id, &run_id)
        .await
        .unwrap()
        .expect("agent run revision");

    PreparedRollbackTemplate {
        scope: space.scope,
        owner,
        run_id,
        expected_run_rev,
        expected_entities,
        warm_note: edited_notes[0].0.clone(),
    }
}

async fn measure_fresh_rollbacks(
    store: &CanonicalStore,
    backend: &'static str,
    iterations: usize,
    enforce_5ms_budget: bool,
) -> RollbackProfileMetrics {
    let mut samples = Vec::with_capacity(iterations);
    for sample in 0..=iterations {
        let fixture = seed_rollback_microfixture(store).await;
        let ctx = owner_ctx(&fixture.scope, fixture.owner.clone());
        store
            .get_note(
                ctx.clone(),
                GetNote {
                    note: fixture.warm_note,
                    revision: None,
                    causal: CausalBasis::Exact(ReceiptSet::default()),
                },
            )
            .await
            .unwrap();
        let request = next_mutation(
            &fixture.scope,
            &fixture.owner,
            RollbackAgentRun {
                run: fixture.run_id,
                expected_run_revision: fixture.expected_run_rev,
                expected_entities: fixture.expected_entities,
                associated_board_expectations: Vec::new(),
            },
        );
        let start = Instant::now();
        let result = store.rollback_agent_run(ctx, request).await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(result.value.restored.len(), 18);
        assert_eq!(result.value.trashed.len(), 2);
        assert_eq!(result.value.skipped_manual_edits.len(), 1);
        if sample > 0 {
            samples.push(u64::try_from(elapsed.as_nanos()).unwrap());
        }
    }
    RollbackProfileMetrics {
        backend,
        iterations,
        enforce_5ms_budget,
        restored_per_call: 18,
        trashed_per_call: 2,
        skipped_manual_per_call: 1,
        latency: compute_percentiles_from_ns(samples),
    }
}

async fn run_sqlite_rollback_benchmark(
    work_root: &Path,
    iterations: usize,
) -> RollbackProfileMetrics {
    let directory = work_root.join("rollback-sqlite");
    let config = CanonicalConfig::local_default(
        InstallationId::from_bytes(random_16()),
        DataRoot::new(&directory),
    );
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let result =
        measure_fresh_rollbacks(&store, "sqlite_wal_full+local_zstd_v1", iterations, true).await;
    runtime.shutdown().await.unwrap();
    fs::remove_dir_all(directory).unwrap();
    result
}

async fn run_pg_rollback_benchmark(
    fixtures: &BenchFixtures,
    work_root: &Path,
    use_s3: bool,
    iterations: usize,
) -> RollbackProfileMetrics {
    let tag = if use_s3 { "rbs3" } else { "rbloc" };
    let live_schema = fixtures.fresh_pg_schema(tag);
    let local_dir = work_root.join(format!("pg-{tag}-cas"));
    let _ = fs::remove_dir_all(&local_dir);
    fs::create_dir_all(&local_dir).unwrap();

    let blobs_cfg = if use_s3 {
        let bucket = fixtures.fresh_s3_bucket(tag);
        let s3_cfg = fixtures.s3_config(bucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure benchmark S3 bucket");
        BlobBackendConfig::S3(Box::new(s3_cfg))
    } else {
        BlobBackendConfig::Local {
            data_root: DataRoot::new(&local_dir),
        }
    };

    let cfg = CanonicalConfig {
        installation_id: InstallationId::from_bytes([0x48; 16]),
        sql: SqlBackendConfig::postgres_default(fixtures.pg_connect(), &live_schema),
        blobs: blobs_cfg,
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: notarium_canonical::config::default_postgres_backup_budget(),
    };

    let (store, rt) = CanonicalRuntime::open(cfg).await.unwrap();
    let backend = if use_s3 {
        "postgres16_sync+s3_chunked_v1_uds"
    } else {
        "postgres16_sync+local_zstd_v1"
    };
    let metrics = measure_fresh_rollbacks(&store, backend, iterations, !use_s3).await;
    rt.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&live_schema).await;
    fs::remove_dir_all(local_dir).unwrap();
    metrics
}

// ============================================================================
// Suite 3: Chat (`p95 < 1 ms`, `0` writes across 10k-turn linear & branched DAG)
// ============================================================================

async fn run_chat_read_benchmarks_for_store(
    store: &CanonicalStore,
    backend_label: &'static str,
    turns_to_seed: usize,
    read_samples: usize,
    pg_settle: Option<(&BenchFixtures, &str)>,
) -> Vec<ChatReadProfileMetrics> {
    let owner = PrincipalId::from_bytes([0x51; 16]);
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0x52; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x53; 16]),
            root_folder_id: FolderId::from_bytes([0x54; 16]),
            slug: "d3-chat-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let ctx = owner_ctx(&space.scope, owner.clone());

    let linear_tid = ChatThreadId::from_bytes([0x55; 16]);
    let branched_tid = ChatThreadId::from_bytes([0x56; 16]);

    store
        .create_chat(
            ctx.clone(),
            next_mutation(
                &space.scope,
                &owner,
                CreateChat {
                    thread: linear_tid.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Linear 10k".to_owned(),
                },
            ),
        )
        .await
        .unwrap();

    store
        .create_chat(
            ctx.clone(),
            next_mutation(
                &space.scope,
                &owner,
                CreateChat {
                    thread: branched_tid.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Branched 10k".to_owned(),
                },
            ),
        )
        .await
        .unwrap();

    // Seed linear and branched 10,000-turn threads concurrently in 2 tasks so they share WriteBatchActor flushes!
    let store_lin = store.clone();
    let scope_lin = space.scope.clone();
    let owner_lin = owner.clone();
    let lin_tid_cl = linear_tid.clone();
    let lin_seeder = tokio::spawn(async move {
        let mut parent = ThreadEntrySeq::ZERO;
        for i in 1..=turns_to_seed {
            let committed = store_lin
                .append_chat(
                    owner_ctx(&scope_lin, owner_lin.clone()),
                    next_mutation(
                        &scope_lin,
                        &owner_lin,
                        AppendChat {
                            thread: lin_tid_cl.clone(),
                            parent,
                            kind: if i % 2 == 1 {
                                ChatEntryKind::Human
                            } else {
                                ChatEntryKind::Model
                            },
                            body: ChatInputBody::Text(format!("linear turn {i} payload")),
                            referenced_notes: Vec::new(),
                            tainted: false,
                        },
                    ),
                )
                .await
                .unwrap();
            parent = committed.value.seq;
        }
        parent
    });

    let store_br = store.clone();
    let scope_br = space.scope.clone();
    let owner_br = owner.clone();
    let br_tid_cl = branched_tid.clone();
    let br_seeder = tokio::spawn(async move {
        let mut main_spine = ThreadEntrySeq::ZERO;
        let mut count = 0usize;
        while count < turns_to_seed {
            // Advance spine by 3 turns
            for _ in 0..3 {
                if count >= turns_to_seed {
                    break;
                }
                count += 1;
                let committed = store_br
                    .append_chat(
                        owner_ctx(&scope_br, owner_br.clone()),
                        next_mutation(
                            &scope_br,
                            &owner_br,
                            AppendChat {
                                thread: br_tid_cl.clone(),
                                parent: main_spine,
                                kind: ChatEntryKind::Human,
                                body: ChatInputBody::Text(format!("spine entry {count}")),
                                referenced_notes: Vec::new(),
                                tainted: false,
                            },
                        ),
                    )
                    .await
                    .unwrap();
                main_spine = committed.value.seq;
            }
            // Fork a 2-turn adversarial side branch off `main_spine` so `is_chain_node = 0` / branch_depth increases!
            if count + 2 <= turns_to_seed && main_spine.get() > 0 {
                store_br
                    .fork_chat(
                        owner_ctx(&scope_br, owner_br.clone()),
                        next_mutation(
                            &scope_br,
                            &owner_br,
                            ForkChat {
                                thread: br_tid_cl.clone(),
                                parent: main_spine,
                            },
                        ),
                    )
                    .await
                    .unwrap();
                let mut side_parent = main_spine;
                for s in 0..2 {
                    count += 1;
                    let side = store_br
                        .append_chat(
                            owner_ctx(&scope_br, owner_br.clone()),
                            next_mutation(
                                &scope_br,
                                &owner_br,
                                AppendChat {
                                    thread: br_tid_cl.clone(),
                                    parent: side_parent,
                                    kind: ChatEntryKind::Model,
                                    body: ChatInputBody::Text(format!(
                                        "side branch {s} at {count}"
                                    )),
                                    referenced_notes: Vec::new(),
                                    tainted: false,
                                },
                            ),
                        )
                        .await
                        .unwrap();
                    side_parent = side.value.seq;
                }
            }
        }
        main_spine
    });

    let linear_leaf = lin_seeder.await.unwrap();
    let branched_leaf = br_seeder.await.unwrap();

    if let Some((fixtures, pg_schema)) = pg_settle {
        let mut raw_pg = fixtures.open_raw_pg().await;
        for stmt in [
            format!(
                "ALTER TABLE \"{pg_schema}\".\"chat_threads\" SET (autovacuum_enabled = false)"
            ),
            format!(
                "ALTER TABLE \"{pg_schema}\".\"chat_entries\" SET (autovacuum_enabled = false)"
            ),
            format!(
                "VACUUM \"{pg_schema}\".\"spaces\", \"{pg_schema}\".\"chat_threads\", \"{pg_schema}\".\"chat_entries\""
            ),
            "CHECKPOINT".to_owned(),
        ] {
            sqlx::raw_sql(sqlx::AssertSqlSafe(stmt))
                .execute(&mut raw_pg)
                .await
                .unwrap();
        }
        let _ = raw_pg.close().await;
    }
    let _ = std::process::Command::new("sync").status();
    tokio::time::sleep(Duration::from_millis(2000)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let limit_50 = PageLimit::new(50).unwrap();
    let mut results = Vec::with_capacity(2);

    for (topology, tid, leaf) in [
        ("linear_10k", linear_tid, linear_leaf),
        ("branched_dag_10k", branched_tid, branched_leaf),
    ] {
        // Warm cache across all opened pool connections (`>= 6` executions/conn for generic plan)
        for _ in 0..96 {
            let warm = store
                .read_chat(
                    owner_ctx(&space.scope, owner.clone()),
                    ChatRead {
                        thread: tid.clone(),
                        leaf,
                        before: None,
                        max_entries: limit_50,
                    },
                )
                .await
                .unwrap();
            assert_eq!(warm.entries.len(), 50.min(turns_to_seed));
        }

        let seq_before = store
            .read_space(&space.scope.space_id)
            .await
            .unwrap()
            .last_seq;
        let change_rows_before = store
            .execute_diagnostic_read_sql_for_test(None, "SELECT COUNT(*) FROM change_log")
            .await
            .unwrap();

        let mut lat_ns = Vec::with_capacity(read_samples);
        for _ in 0..read_samples {
            let rctx = owner_ctx(&space.scope, owner.clone());
            let req = ChatRead {
                thread: tid.clone(),
                leaf,
                before: None,
                max_entries: limit_50,
            };
            let t0 = Instant::now();
            let branch = store.read_chat(rctx, req).await.unwrap();
            let elapsed_ns = u64::try_from(t0.elapsed().as_nanos()).unwrap_or(u64::MAX);
            assert_eq!(branch.entries.len(), 50.min(turns_to_seed));
            lat_ns.push(elapsed_ns);
        }

        let seq_after = store
            .read_space(&space.scope.space_id)
            .await
            .unwrap()
            .last_seq;
        let change_rows_after = store
            .execute_diagnostic_read_sql_for_test(None, "SELECT COUNT(*) FROM change_log")
            .await
            .unwrap();
        let writes_delta = (seq_after.get() - seq_before.get())
            + (change_rows_after.saturating_sub(change_rows_before) as u64);
        assert_eq!(
            writes_delta, 0,
            "chat branch reads must perform 0 SQL writes"
        );

        let pct = compute_percentiles_from_ns(lat_ns);
        results.push(ChatReadProfileMetrics {
            backend: backend_label,
            topology,
            seeded_turns: turns_to_seed,
            window_entries: 50.min(turns_to_seed),
            measured_reads: read_samples,
            sql_writes_during_reads: writes_delta,
            latency: pct,
        });
    }

    results
}

// ============================================================================
// Suite 4A: Board 10,000 consecutive first-slot moves (`rank.len() <= 16`)
// ============================================================================

struct FastBenchBoardCard {
    note: NoteId,
    slug: String,
    note_rev: RevisionId,
}

struct FastBenchBoardPlanner {
    store: CanonicalStore,
    view_rev: RevisionId,
    cards: StdMutex<Vec<FastBenchBoardCard>>,
}

impl BoardMutationFactsProvider for FastBenchBoardPlanner {
    fn evaluate_move<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        _cutoff: Option<SpaceSeq>,
        intent: MoveBoardCard,
    ) -> PortFuture<'a, BoardMoveFacts> {
        Box::pin(async move {
            let scope = ctx.scope().clone();
            let space_rec = self.store.read_space(&scope.space_id).await?;
            let overlays = self
                .store
                .inspect_view_overlays_for_test(&scope.space_id, &intent.view)
                .await?;
            let cards_snapshot: Vec<(NoteId, String, RevisionId)> = self
                .cards
                .lock()
                .unwrap()
                .iter()
                .map(|c| (c.note.clone(), c.slug.clone(), c.note_rev.clone()))
                .collect();

            let grp = GroupKey::Value(ScalarValue::String("todo".to_owned()));
            let mut entries = Vec::with_capacity(cards_snapshot.len());
            let mut target_slug = String::new();

            for (nid, slug, nrev) in cards_snapshot {
                if nid == intent.note {
                    target_slug = slug.clone();
                }
                let ov_opt = overlays.get(&nid);
                let exp_rank = match ov_opt {
                    Some(ov) => RankExpectation::Existing(ov.rank_rev_id.clone()),
                    None => RankExpectation::Absent,
                };
                let sort_rank = ov_opt.map(|ov| ov.sort_rank_lexo.clone());
                let mut h = blake3::Hasher::new();
                h.update(slug.as_bytes());
                h.update(&[0]);
                h.update(nid.as_str().as_bytes());
                let binding = ContentDigest::from_bytes(*h.finalize().as_bytes());

                entries.push((
                    sort_rank,
                    slug,
                    EvaluatedBoardRow {
                        note: nid,
                        expected_note: nrev,
                        expected_rank: exp_rank,
                        base_order_binding: binding,
                    },
                ));
            }

            entries.sort_by(|a, b| {
                let ra = a.0.as_deref().unwrap_or("~");
                let rb = b.0.as_deref().unwrap_or("~");
                ra.cmp(rb)
                    .then_with(|| a.1.cmp(&b.1))
                    .then_with(|| a.2.note.cmp(&b.2.note))
            });

            let rows: Vec<EvaluatedBoardRow> = entries.into_iter().map(|(_, _, r)| r).collect();
            let pos = rows
                .iter()
                .position(|r| r.note == intent.note)
                .expect("target card in board group");
            let before_placement = SemanticPlacement::InGroup {
                group: grp.clone(),
                predecessor: pos.checked_sub(1).map(|i| rows[i].note.clone()),
                successor: rows.get(pos + 1).map(|r| r.note.clone()),
            };

            let mut th = blake3::Hasher::new();
            th.update(target_slug.as_bytes());
            th.update(&[0]);
            th.update(intent.note.as_str().as_bytes());
            let target_binding = ContentDigest::from_bytes(*th.finalize().as_bytes());

            Ok(BoardMoveFacts::attest(
                authority,
                BoardMoveFactsSpec {
                    scope,
                    cutoff: space_rec.last_seq,
                    view: intent.view,
                    view_revision: self.view_rev.clone(),
                    schema_revision: None,
                    descriptor_fingerprint: ContentDigest::from_bytes([0u8; 32]),
                    group_field: "status".to_owned(),
                    group_field_kind: BoardGroupFieldKind::String,
                    groups: vec![EvaluatedBoardGroup { group: grp, rows }],
                    before_placement,
                    base_order_binding: target_binding,
                    after_eligible_in_group: true,
                },
            ))
        })
    }

    fn evaluate_rollback<'a>(
        &'a self,
        _authority: &'a BoardPlannerAuthority,
        _ctx: SpaceContext,
        _request: RollbackBoardFactsRequest,
    ) -> PortFuture<'a, RollbackBoardFacts> {
        Box::pin(async move { unreachable!("unused in board first-slot benchmark") })
    }
}

async fn run_board_first_slot_benchmark(
    store: &CanonicalStore,
    backend_label: &'static str,
    total_moves: usize,
) -> BoardFirstSlotMetrics {
    let owner = PrincipalId::from_bytes([0x61; 16]);
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0x62; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x63; 16]),
            root_folder_id: FolderId::from_bytes([0x64; 16]),
            slug: "d3-board-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let ctx = owner_ctx(&space.scope, owner.clone());

    let view_nid = NoteId::from_bytes([0x65; 16]);
    let view_created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &space.scope,
                &owner,
                CreateNote {
                    note: view_nid.clone(),
                    parent: None,
                    slug: "kanban".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Kanban\n---\n# Kanban\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let view_rev = view_created.value.revision;
    let view_ref = ViewRef {
        note: view_nid,
        key: ViewKey::from_bytes([0x67; 16]),
    };

    const CARD_COUNT: usize = 32;
    let mut cards = Vec::with_capacity(CARD_COUNT);
    let mut card_revs = BTreeMap::new();
    for idx in 0..CARD_COUNT {
        let mut nb = [0u8; 16];
        nb[0] = 0x66;
        nb[15] = idx as u8;
        let nid = NoteId::from_bytes(nb);
        let slug = format!("card-{idx:02}");
        let cr = store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &space.scope,
                    &owner,
                    CreateNote {
                        note: nid.clone(),
                        parent: None,
                        slug: slug.clone(),
                        class: DocClass::UserDoc,
                        carrier: format!(
                            "---\ntitle: Card {idx}\nstatus: todo\n---\n# Card {idx}\n"
                        ),
                    },
                ),
            )
            .await
            .unwrap();
        card_revs.insert(nid.clone(), cr.value.revision.clone());
        cards.push(FastBenchBoardCard {
            note: nid,
            slug,
            note_rev: cr.value.revision,
        });
    }

    let planner = Arc::new(FastBenchBoardPlanner {
        store: store.clone(),
        view_rev: view_rev.clone(),
        cards: StdMutex::new(cards),
    });
    store.register_board_facts_provider(planner).unwrap();

    let todo_grp = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let mut lat_ns = Vec::with_capacity(total_moves);
    let mut max_rank_bytes = 0usize;
    let mut rebalance_events = 0usize;
    let mut max_changed_in_move = 0usize;
    let mut total_changed_overlays = 0usize;

    let mut prev_overlays = store
        .inspect_view_overlays_for_test(&space.scope.space_id, &view_ref)
        .await
        .unwrap();

    for m in 0..total_moves {
        // Sort current cards in group order to pick the current tail card and move it before the current FIRST slot!
        let mut order: Vec<(Option<String>, String, NoteId)> = (0..CARD_COUNT)
            .map(|idx| {
                let mut nb = [0u8; 16];
                nb[0] = 0x66;
                nb[15] = idx as u8;
                let nid = NoteId::from_bytes(nb);
                let slug = format!("card-{idx:02}");
                let r = prev_overlays.get(&nid).map(|ov| ov.sort_rank_lexo.clone());
                (r, slug, nid)
            })
            .collect();
        order.sort_by(|a, b| {
            let ra = a.0.as_deref().unwrap_or("~");
            let rb = b.0.as_deref().unwrap_or("~");
            ra.cmp(rb)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });

        let first_nid = order[0].2.clone();
        let moving_nid = order[CARD_COUNT - 1].2.clone();
        let moving_note_rev = card_revs.get(&moving_nid).unwrap().clone();

        let first_exp_rank = match prev_overlays.get(&first_nid) {
            Some(ov) => RankExpectation::Existing(ov.rank_rev_id.clone()),
            None => RankExpectation::Absent,
        };
        let moving_exp_rank = match prev_overlays.get(&moving_nid) {
            Some(ov) => RankExpectation::Existing(ov.rank_rev_id.clone()),
            None => RankExpectation::Absent,
        };

        let req = next_mutation(
            &space.scope,
            &owner,
            MoveBoardCard {
                view: view_ref.clone(),
                note: moving_nid.clone(),
                group: todo_grp.clone(),
                before: Some(RankNeighbor {
                    note: first_nid,
                    expected_rank: first_exp_rank,
                }),
                after: None,
                fields: BTreeMap::new(),
                expected_note: moving_note_rev,
                expected_view: view_rev.clone(),
                expected_rank: moving_exp_rank,
            },
        );

        let mctx = owner_ctx(&space.scope, owner.clone());
        let t0 = Instant::now();
        let committed = store.move_board_card(mctx, req).await.unwrap();
        let elapsed_ns = u64::try_from(t0.elapsed().as_nanos()).unwrap_or(u64::MAX);
        lat_ns.push(elapsed_ns);

        let rank_len = committed.value.rank.len();
        assert!(
            rank_len <= 16,
            "D3 board rank bound violated at move {m}: len={rank_len} > 16"
        );
        max_rank_bytes = max_rank_bytes.max(rank_len);

        let after_overlays = match store
            .inspect_view_overlays_for_test(&space.scope.space_id, &view_ref)
            .await
        {
            Ok(ov) => ov,
            Err(notarium_core::error::PortError::DeadlineExceeded(_)) => {
                tokio::time::sleep(Duration::from_millis(10)).await;
                store
                    .inspect_view_overlays_for_test(&space.scope.space_id, &view_ref)
                    .await
                    .unwrap()
            }
            Err(err) => panic!("inspect_view_overlays_for_test failed: {err:?}"),
        };
        let mut changed_count = 0usize;
        for (nid, ov_after) in &after_overlays {
            assert!(
                ov_after.sort_rank_lexo.len() <= 16,
                "overlay rank exceeded 16B on {nid}"
            );
            max_rank_bytes = max_rank_bytes.max(ov_after.sort_rank_lexo.len());
            let changed = match prev_overlays.get(nid) {
                Some(ov_before) => ov_before.rank_rev_id != ov_after.rank_rev_id,
                None => true,
            };
            if changed {
                changed_count += 1;
            }
        }
        if changed_count > 1 {
            rebalance_events += 1;
        }
        max_changed_in_move = max_changed_in_move.max(changed_count);
        total_changed_overlays += changed_count;
        prev_overlays = after_overlays;
    }

    let pct = compute_percentiles_from_ns(lat_ns);
    BoardFirstSlotMetrics {
        backend: backend_label,
        moves_executed: total_moves,
        max_rank_bytes_observed: max_rank_bytes,
        pma_rebalance_events: rebalance_events,
        max_overlays_changed_in_single_move: max_changed_in_move,
        mean_overlays_changed_per_move: (total_changed_overlays as f64) / (total_moves as f64),
        latency: pct,
    }
}

// ============================================================================
// Suite 4B: Folder 100,000-descendant `MoveFolder` (`0` descendant writes)
// ============================================================================

async fn run_folder_100k_move_benchmark(
    store: &CanonicalStore,
    backend_label: &'static str,
    descendant_folders: usize,
    descendant_notes: usize,
    move_iters: usize,
) -> FolderMoveMetrics {
    let owner = PrincipalId::from_bytes([0x71; 16]);
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0x72; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x73; 16]),
            root_folder_id: FolderId::from_bytes([0x74; 16]),
            slug: "d3-folder-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();

    let parent_a = FolderId::from_bytes([0x75; 16]);
    let parent_b = FolderId::from_bytes([0x76; 16]);
    let moving_folder = FolderId::from_bytes([0x77; 16]);

    for (fid, parent, slug, name) in [
        (parent_a.clone(), None, "parent-a", "Parent A"),
        (parent_b.clone(), None, "parent-b", "Parent B"),
        (
            moving_folder.clone(),
            Some(parent_a.clone()),
            "moving-subtree",
            "Moving Subtree",
        ),
    ] {
        store
            .create_folder(CreateFolderSpec {
                scope: space.scope.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                folder_id: fid,
                parent,
                slug: slug.to_owned(),
                display_name: name.to_owned(),
                is_project: false,
                project_slug: None,
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }

    let sid = space.scope.space_id.as_str();
    let actor_str = owner.as_str();
    let mut seq_cursor = store
        .read_space(&space.scope.space_id)
        .await
        .unwrap()
        .last_seq
        .get();

    // Bulk-seed `descendant_folders` nested child folders under `moving_folder` (multi-level tree)
    let mut sub_folder_ids = Vec::with_capacity(descendant_folders);
    for idx in 0..descendant_folders {
        let mut fb = [0u8; 16];
        fb[0] = 0x78;
        fb[8..16].copy_from_slice(&(idx as u64).to_be_bytes());
        sub_folder_ids.push(FolderId::from_bytes(fb));
    }

    for chunk_start in (0..descendant_folders).step_by(500) {
        let chunk_end = (chunk_start + 500).min(descendant_folders);
        let mut sql = String::from(
            "INSERT INTO folder_heads (
                space_id, folder_id, parent_folder_id, is_root, slug, slug_fold,
                display_name, is_project, project_slug, project_slug_fold,
                description, cover_note_id, write_lock_json, lifecycle_state,
                rev_seq, head_rev_id, created_seq, updated_seq, updated_at_sec, updated_at_nsec
            ) VALUES ",
        );
        for idx in chunk_start..chunk_end {
            if idx > chunk_start {
                sql.push(',');
            }
            seq_cursor += 1;
            let fid = sub_folder_ids[idx].as_str();
            let parent_id = if idx < 10 {
                moving_folder.as_str()
            } else {
                sub_folder_ids[(idx - 10) / 4].as_str()
            };
            sql.push_str(&format!(
                "('{sid}', '{fid}', '{parent_id}', 0, 'sub-{idx}', 'sub-{idx}', \
                 'Sub {idx}', 0, NULL, NULL, NULL, NULL, NULL, 'active', \
                 1, 'rev_10000000{:024x}', {seq_cursor}, {seq_cursor}, 1700000000, 0)",
                idx
            ));
        }
        store
            .execute_diagnostic_write_sql_for_test(&sql)
            .await
            .unwrap();
    }

    // Bulk-seed `descendant_notes` active notes distributed across `moving_folder` and its child folders
    let dummy_digest_lit = if backend_label.starts_with("sqlite") {
        "X'1111111111111111111111111111111111111111111111111111111111111111'"
    } else {
        "'\\x1111111111111111111111111111111111111111111111111111111111111111'::bytea"
    };
    for chunk_start in (0..descendant_notes).step_by(500) {
        let chunk_end = (chunk_start + 500).min(descendant_notes);
        let mut sql = String::from(
            "INSERT INTO note_heads (
                space_id, note_id, parent_folder_id, slug, slug_fold, title, title_fold,
                doc_class, ability_id, head_rev_id, content_blake3, byte_size,
                lifecycle_state, visibility_mask, settlement_successor_id,
                created_seq, updated_seq, created_at_sec, created_at_nsec,
                updated_at_sec, updated_at_nsec, last_actor_id
            ) VALUES ",
        );
        for idx in chunk_start..chunk_end {
            if idx > chunk_start {
                sql.push(',');
            }
            seq_cursor += 1;
            let mut nb = [0u8; 16];
            nb[0] = 0x79;
            nb[8..16].copy_from_slice(&(idx as u64).to_be_bytes());
            let nid = NoteId::from_bytes(nb);
            let parent_id = if sub_folder_ids.is_empty() {
                moving_folder.as_str()
            } else {
                sub_folder_ids[idx % sub_folder_ids.len()].as_str()
            };
            sql.push_str(&format!(
                "('{sid}', '{}', '{parent_id}', 'n-{idx}', 'n-{idx}', 'Note {idx}', 'note {idx}', \
                 'user-doc', NULL, 'rev_20000000{:024x}', {dummy_digest_lit}, 128, \
                 'active', 0, NULL, {seq_cursor}, {seq_cursor}, 1700000000, 0, 1700000000, 0, '{actor_str}')",
                nid.as_str(),
                idx
            ));
        }
        store
            .execute_diagnostic_write_sql_for_test(&sql)
            .await
            .unwrap();
    }

    store
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE spaces SET last_seq = {seq_cursor} WHERE space_id = '{sid}'"
        ))
        .await
        .unwrap();

    let baseline_seq = seq_cursor;

    let total_folders_db = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM folder_heads WHERE space_id = '{sid}' AND folder_id NOT IN ('{}', '{}', '{}', '{}')",
                FolderId::from_bytes([0x74; 16]).as_str(),
                parent_a.as_str(),
                parent_b.as_str(),
                moving_folder.as_str()
            ),
        )
        .await
        .unwrap();
    let total_notes_db = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!("SELECT COUNT(*) FROM note_heads WHERE space_id = '{sid}'"),
        )
        .await
        .unwrap();
    assert_eq!(total_folders_db as usize, descendant_folders);
    assert_eq!(total_notes_db as usize, descendant_notes);

    let mut lat_ns = Vec::with_capacity(move_iters);
    for iter in 0..move_iters {
        let dst = if iter % 2 == 0 {
            parent_b.clone()
        } else {
            parent_a.clone()
        };
        let mctx = owner_ctx(&space.scope, owner.clone());
        let req = next_mutation(
            &space.scope,
            &owner,
            MoveFolder {
                folder: moving_folder.clone(),
                new_parent: Some(dst),
            },
        );
        let t0 = Instant::now();
        store.move_folder(mctx, req).await.unwrap();
        let elapsed_ns = u64::try_from(t0.elapsed().as_nanos()).unwrap_or(u64::MAX);
        lat_ns.push(elapsed_ns);
    }

    let touched_descendant_folders = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM folder_heads WHERE space_id = '{sid}' AND folder_id <> '{}' AND updated_seq > {baseline_seq}",
                moving_folder.as_str()
            ),
        )
        .await
        .unwrap();
    let touched_descendant_notes = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM note_heads WHERE space_id = '{sid}' AND updated_seq > {baseline_seq}"
            ),
        )
        .await
        .unwrap();
    let descendant_writes = (touched_descendant_folders + touched_descendant_notes) as u64;
    assert_eq!(
        descendant_writes, 0,
        "MoveFolder must touch 0 descendant folder/note rows"
    );

    FolderMoveMetrics {
        backend: backend_label,
        seeded_descendant_folders: descendant_folders,
        seeded_descendant_notes: descendant_notes,
        total_seeded_descendants: descendant_folders + descendant_notes,
        moves_executed: move_iters,
        descendant_rows_modified: descendant_writes,
        latency: compute_percentiles_from_ns(lat_ns),
    }
}

// ============================================================================
// Suite 5: Paired Backup Pause (`p95 < 1 ms` across >= 1,000 captures)
// ============================================================================

async fn measure_paired_cuts(
    control: &ControlBackup,
    canonical: &CanonicalStore,
    backend: &'static str,
    spaces: usize,
    captures: usize,
) -> PairedBackupPauseMetrics {
    let budget = canonical.default_backup_budget();
    let mut pause = Vec::with_capacity(captures);
    let mut drain = Vec::with_capacity(captures);
    let mut confirmed_pause = Vec::with_capacity(captures);
    let mut prepare = Vec::with_capacity(captures);
    for iteration in 0..=captures {
        let id = BackupId::from_bytes(random_16());
        let start = Instant::now();
        let mut a = control
            .prepare(maintenance_ctx(ServicePurpose::Backup), id.clone(), budget)
            .await
            .unwrap();
        let mut b = canonical
            .prepare(maintenance_ctx(ServicePurpose::Backup), id, budget)
            .await
            .unwrap();
        let control_hold = a.acquire_hold().await.unwrap();
        let canonical_hold = b.acquire_hold().await.unwrap();
        let prepared = start.elapsed();
        let waiting = Instant::now();
        let mut paused_control = a.pause_writes().await.unwrap();
        // Control is already paused while canonical drains to its safe point.
        let pause_started = Instant::now();
        let mut paused_canonical = b.pause_writes().await.unwrap();
        let both_paused = waiting.elapsed();
        let (control_snapshot, canonical_snapshot) =
            tokio::join!(paused_control.open_cut(), paused_canonical.open_cut());
        let control_snapshot = control_snapshot.unwrap();
        let canonical_snapshot = canonical_snapshot.unwrap();
        let (canonical_resumed, control_resumed) =
            tokio::join!(paused_canonical.resume(), paused_control.resume());
        canonical_resumed.unwrap();
        control_resumed.unwrap();
        let resumed = Instant::now();
        let dwell = resumed.duration_since(waiting);
        let confirmed_dwell = resumed.duration_since(pause_started);
        assert_eq!(
            control_snapshot.witness().installation,
            canonical_snapshot.witness().installation
        );
        assert_eq!(control_snapshot.witness().canaries.len(), 1);
        assert_eq!(canonical_snapshot.witness().histories.len(), spaces);
        canonical_snapshot.close().await.unwrap();
        control_snapshot.close().await.unwrap();
        canonical_hold.release().await.unwrap();
        control_hold.release().await.unwrap();
        if iteration != 0 {
            pause.push(u64::try_from(dwell.as_nanos()).unwrap());
            drain.push(u64::try_from(both_paused.as_nanos()).unwrap());
            confirmed_pause.push(u64::try_from(confirmed_dwell.as_nanos()).unwrap());
            prepare.push(u64::try_from(prepared.as_nanos()).unwrap());
        }
    }
    PairedBackupPauseMetrics {
        backend,
        canonical_spaces: spaces,
        captures,
        pause_latency: compute_percentiles_from_ns(pause),
        drain_latency: compute_percentiles_from_ns(drain),
        confirmed_pause_latency: compute_percentiles_from_ns(confirmed_pause),
        prepare_and_hold_latency: compute_percentiles_from_ns(prepare),
    }
}

async fn paired_profiles(
    fixtures: &BenchFixtures,
    work_root: &Path,
    postgres: bool,
    captures: usize,
) -> Vec<PairedBackupPauseMetrics> {
    let backend = if postgres {
        "postgres16_control_canonical"
    } else {
        "sqlite_control_canonical"
    };
    let data_root = DataRoot::new(work_root.join(backend));
    fs::create_dir_all(data_root.control().parent().unwrap()).unwrap();
    let installation = InstallationId::from_bytes(random_16());
    let mut cfg = CanonicalConfig::local_default(installation.clone(), data_root.clone());
    let schema = fixtures.fresh_pg_schema("paired");
    let (control_db, keyring) = if postgres {
        cfg.sql = SqlBackendConfig::postgres_default(fixtures.pg_connect(), &schema);
        cfg.default_backup_budget = notarium_canonical::config::default_postgres_backup_budget();
        let db = ControlStore::postgres(PostgresConfig::unix_socket(
            fixtures.pg_socket_dir.clone(),
            &fixtures.pg_database,
            &fixtures.pg_user,
        ))
        .await
        .unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../notarium-control/tests/fixtures/keyring");
        let keys: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.join("vectors.json")).unwrap()).unwrap();
        let mut conn = fixtures.open_raw_pg().await;
        sqlx::query("INSERT INTO v1_control.v1_storage_epoch(singleton,epoch_version,state,installation_id) VALUES(1,1,'ready',$1)")
            .bind(installation.as_str()).execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO v1_control.secret_keyring(key_id,key_hash,generation,state,canary,created_at) VALUES($1,$2,1,'active',$3,0)")
            .bind(keys["keyId"].as_str().unwrap()).bind(keys["keyHash"].as_str().unwrap())
            .bind(keys["canaryEnvelope"].as_str().unwrap()).execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        let keyring = Keyring::open(
            db.clone(),
            KeyringLocation::External(fixture.join("native")),
            make_budget(),
        )
        .await
        .unwrap();
        (db, keyring)
    } else {
        let db = ControlStore::sqlite(&data_root).await.unwrap();
        let empty = EmptyRootAuthorization::from_classification(
            installation.clone(),
            EpochClassification {
                state: StorageEpochState::EmptyRoot,
                reason: EpochReason::ConfirmedEmpty,
            },
        )
        .unwrap();
        let keyring =
            FreshLocalInitializer::initialize(db.clone(), data_root.clone(), empty, make_budget())
                .await
                .unwrap();
        rusqlite::Connection::open(data_root.control())
            .unwrap()
            .execute(
                "UPDATE v1_storage_epoch SET state='ready' WHERE singleton=1",
                [],
            )
            .unwrap();
        (db, keyring)
    };
    let control = ControlBackup::new(
        control_db.clone(),
        keyring,
        data_root,
        BackupConfig::default(),
    )
    .unwrap();
    let (canonical, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let mut metrics = Vec::new();
    let mut seeded = 0;
    for spaces in [1, 64] {
        for n in seeded..spaces {
            canonical
                .create_space(CreateSpaceSpec {
                    space_id: SpaceId::from_bytes(random_16()),
                    incarnation: HistoryIncarnation::from_bytes(random_16()),
                    root_folder_id: FolderId::from_bytes(random_16()),
                    slug: format!("paired-{n}"),
                    kind: SpaceKind::Shared,
                    owner: PrincipalId::from_bytes(random_16()),
                    active_epoch: LeaseEpoch::new(1).unwrap(),
                    initial_last_seq: SpaceSeq::ZERO,
                    created_at: None,
                })
                .await
                .unwrap();
        }
        seeded = spaces;
        metrics.push(measure_paired_cuts(&control, &canonical, backend, spaces, captures).await);
    }
    runtime.shutdown().await.unwrap();
    drop(control);
    control_db.close().await;
    if postgres {
        fixtures.drop_pg_schema(&schema).await;
    }
    metrics
}

async fn run_paired_profiles(
    fixtures: &BenchFixtures,
    work_root: &Path,
    backup_captures: usize,
) -> Vec<PairedBackupPauseMetrics> {
    eprintln!("[D3] paired control/canonical backup ({backup_captures} captures per profile)...");
    let mut paired_backup_pause_profiles =
        paired_profiles(fixtures, work_root, false, backup_captures).await;
    paired_backup_pause_profiles
        .extend(paired_profiles(fixtures, work_root, true, backup_captures).await);
    for pp in &paired_backup_pause_profiles {
        eprintln!(
            "[D3]   -> {} ({} spaces): confirmed p50/p95={:.1}/{:.1} us; inclusive p50/p95={:.1}/{:.1} us",
            pp.backend,
            pp.canonical_spaces,
            pp.confirmed_pause_latency.p50_us,
            pp.confirmed_pause_latency.p95_us,
            pp.pause_latency.p50_us,
            pp.pause_latency.p95_us
        );
    }

    paired_backup_pause_profiles
}

fn write_report(report: &impl Serialize, path: &Path, met_targets: bool) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create output parent directory");
    }
    let json = serde_json::to_string_pretty(report).expect("serialize D3 report");
    fs::write(path, format!("{json}\n")).expect("write D3 report JSON");
    println!("{}", path.display());
    if !met_targets {
        std::process::exit(1);
    }
}

// ============================================================================
// Entrypoint
// ============================================================================

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = env::args().collect();
    let smoke_mode = args.iter().any(|a| a == "--smoke");
    let hash_arg = |key: &str| {
        let value = args
            .windows(2)
            .find(|w| w[0] == key)
            .map(|w| w[1].clone())
            .expect("run through with-storage-fixtures.sh benchmark");
        assert!(
            value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid {key}"
        );
        value
    };
    let git_base_commit = hash_arg("--git-base");
    let head_tree = hash_arg("--head-tree");
    let git_tree = hash_arg("--git-tree");
    let git_commit = (head_tree == git_tree).then(|| git_base_commit.clone());
    let out_file = args
        .windows(2)
        .find(|w| w[0] == "--output")
        .map(|w| PathBuf::from(&w[1]))
        .expect("path for --output");

    if cfg!(debug_assertions) && !smoke_mode {
        panic!("d3_benchmarks must be compiled and run with `--release`");
    }

    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .expect("repository root");
    let artifact_dir = if Path::new("/workspace").exists() {
        PathBuf::from("/workspace/.artifacts/3-storage-cas")
    } else {
        repo_root.join(".artifacts/3-storage-cas")
    };
    let work_root = artifact_dir.join("bench-work");
    let _ = fs::remove_dir_all(&work_root);
    fs::create_dir_all(&work_root).expect("create benchmark work root");

    let (fstype, mount_point) = verify_non_tmpfs_mount(&work_root);
    let warmup_dur = if smoke_mode {
        Duration::from_secs(2)
    } else {
        Duration::from_secs(10)
    };
    let measure_dur = if smoke_mode {
        Duration::from_secs(4)
    } else {
        Duration::from_secs(30)
    };

    let fixtures = BenchFixtures::load_required(repo_root);

    // Verify PostgreSQL `synchronous_commit = on`
    let (pg_sync_commit, postgres_select_one_rtt) = {
        let mut conn = fixtures.open_raw_pg().await;
        let val: String = sqlx::query_scalar("SHOW synchronous_commit")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let mut rtt = Vec::with_capacity(100);
        for _ in 0..100 {
            let start = Instant::now();
            let one: i32 = sqlx::query_scalar("SELECT 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            rtt.push(u64::try_from(start.elapsed().as_nanos()).unwrap());
            assert_eq!(one, 1);
        }
        let _ = conn.close().await;
        assert_eq!(
            val, "on",
            "PostgreSQL fixture must enforce synchronous_commit=on"
        );
        (val, compute_percentiles_from_ns(rtt))
    };

    let writer_runs = if smoke_mode { 1usize } else { 3usize };
    let rb_iters = if smoke_mode { 100usize } else { 1_000usize };
    let rb_s3_iters = if smoke_mode { 10usize } else { 200usize };
    let chat_turns = if smoke_mode { 512usize } else { 10_000usize };
    let chat_reads = if smoke_mode { 200usize } else { 10_000usize };
    let board_moves = if smoke_mode { 200usize } else { 10_000usize };
    let desc_folders = if smoke_mode { 100usize } else { 1_000usize };
    let desc_notes = if smoke_mode { 900usize } else { 99_000usize };
    let folder_moves = if smoke_mode { 50usize } else { 1_000usize };
    let backup_captures = if smoke_mode { 50usize } else { 1_000usize };

    // Settle any prior build/container writeback past ext4's 5s `jbd2` commit interval before timing.
    let _ = std::process::Command::new("sync").status();
    tokio::time::sleep(Duration::from_millis(5500)).await;
    let _ = std::process::Command::new("sync").status();
    tokio::time::sleep(Duration::from_millis(500)).await;
    eprintln!("[D3] starting benchmark suite (smoke={smoke_mode}, fs={fstype} on {mount_point})");

    let environment = EnvironmentAttribution {
        generated_at_unix_s: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        rust_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        git_base_commit,
        git_commit,
        git_tree,
        fixture_launcher_cpu_max: args
            .windows(2)
            .find(|w| w[0] == "--caller-cgroup-cpu")
            .map(|w| w[1].clone())
            .unwrap_or_else(|| "unknown".into()),
        fixture_launcher_memory_max: args
            .windows(2)
            .find(|w| w[0] == "--caller-cgroup-memory")
            .map(|w| w[1].clone())
            .unwrap_or_else(|| "unknown".into()),
        cgroup_cpu_max: read_trimmed_or_unknown("/sys/fs/cgroup/cpu.max"),
        cgroup_memory_max: read_trimmed_or_unknown("/sys/fs/cgroup/memory.max"),
        available_parallelism: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        kernel_release: read_trimmed_or_unknown("/proc/sys/kernel/osrelease"),
        work_dir: work_root.to_string_lossy().into_owned(),
        filesystem_type: fstype,
        filesystem_mount_point: mount_point,
        sqlite_wal_soft_watermark_bytes: 512 * 1024 * 1024,
        sqlite_wal_high_watermark_bytes: 896 * 1024 * 1024,
        postgres_transport: "local_unix_domain_socket",
        postgres_synchronous_commit: pg_sync_commit,
        postgres_select_one_rtt,
        s3_transport: "local_unix_domain_socket_bridge_to_loopback_minio_ce",
        writer_max_batch_items: WriterConfig::default().max_batch_items,
        writer_carrier_bytes: CARRIER_TARGET_BYTES,
        cache_warmth_policy: "writer warmup, fresh previously unrolled run per rollback, warm chat windows",
        fixture_run_id: fixtures.run_id.clone(),
        minio_release_tag: fixtures.minio_release_tag.clone(),
        minio_source_commit: fixtures.minio_source_commit.clone(),
        smoke_mode,
    };

    if args.iter().any(|arg| arg == "--paired-only") {
        let profiles = run_paired_profiles(&fixtures, &work_root, backup_captures).await;
        let met_targets = profiles
            .iter()
            .all(|p| p.confirmed_pause_latency.p95_us < 1_000.0);
        let report = serde_json::json!({
            "suite": "paired_backup",
            "status": if !met_targets { "FAIL" } else if smoke_mode { "SMOKE" } else { "PASS" },
            "environment": environment,
            "paired_backup_pause_profiles": profiles,
        });
        fs::remove_dir_all(&work_root).unwrap();
        write_report(&report, &out_file, met_targets);
        return;
    }

    // 1. Rollback microfixture (run first on clean filesystem before 500k+ CAS file churn)
    eprintln!("[D3] rollback microfixture ({rb_iters} independent resets)...");
    let rb_sqlite = run_sqlite_rollback_benchmark(&work_root, rb_iters).await;
    eprintln!(
        "[D3]   -> SQLite+Local min={:.1} us, p50={:.1} us, p95={:.1} us, p99={:.1} us, max={:.1} us",
        rb_sqlite.latency.min_us,
        rb_sqlite.latency.p50_us,
        rb_sqlite.latency.p95_us,
        rb_sqlite.latency.p99_us,
        rb_sqlite.latency.max_us,
    );
    tokio::time::sleep(Duration::from_millis(3000)).await;
    let rb_pg_local = run_pg_rollback_benchmark(&fixtures, &work_root, false, rb_iters).await;
    eprintln!(
        "[D3]   -> PG16+Local   min={:.1} us, p50={:.1} us, p95={:.1} us, p99={:.1} us, max={:.1} us",
        rb_pg_local.latency.min_us,
        rb_pg_local.latency.p50_us,
        rb_pg_local.latency.p95_us,
        rb_pg_local.latency.p99_us,
        rb_pg_local.latency.max_us,
    );
    let rb_pg_s3 = run_pg_rollback_benchmark(&fixtures, &work_root, true, rb_s3_iters).await;
    eprintln!(
        "[D3]   -> PG16+S3(UDS) min={:.1} us, p50={:.1} us, p95={:.1} us, p99={:.1} us, max={:.1} us",
        rb_pg_s3.latency.min_us,
        rb_pg_s3.latency.p50_us,
        rb_pg_s3.latency.p95_us,
        rb_pg_s3.latency.p99_us,
        rb_pg_s3.latency.max_us,
    );
    let rollback_profiles = vec![rb_sqlite, rb_pg_local, rb_pg_s3];

    // 2. Writer 50w/0r & 50w/200r
    let _ = std::process::Command::new("sync").status();
    tokio::time::sleep(Duration::from_millis(5500)).await;
    let _ = std::process::Command::new("sync").status();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut writer_50w_0r_runs = Vec::with_capacity(writer_runs);
    let mut writer_50w_200r_runs = Vec::with_capacity(writer_runs);
    for r in 1..=writer_runs {
        eprintln!("[D3] writer 50w/0r run {r}/{writer_runs}...");
        let m = run_writer_benchmark_case(&work_root, r, 50, 0, warmup_dur, measure_dur).await;
        eprintln!(
            "[D3]   -> {:.1} mut/s, p95={:.1} us, phase2_p95={:.1} us (mean batch {:.1})",
            m.throughput_mut_per_sec,
            m.admission_to_receipt.p95_us,
            m.phase2_batch_commit.p95_us,
            m.mean_batch_items
        );
        writer_50w_0r_runs.push(m);
    }

    for r in 1..=writer_runs {
        eprintln!("[D3] writer 50w/200r run {r}/{writer_runs}...");
        let m = run_writer_benchmark_case(&work_root, r, 50, 200, warmup_dur, measure_dur).await;
        eprintln!(
            "[D3]   -> {:.1} mut/s ({} reads), p95={:.1} us, phase2_p95={:.1} us",
            m.throughput_mut_per_sec,
            m.measured_reads_completed,
            m.admission_to_receipt.p95_us,
            m.phase2_batch_commit.p95_us
        );
        writer_50w_200r_runs.push(m);
    }

    let _ = std::process::Command::new("sync").status();
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // 3. Chat 50-entry window in 10k linear & branched DAG
    eprintln!("[D3] chat 10k linear & branched DAG ({chat_reads} reads)...");
    let mut chat_read_profiles = Vec::new();
    {
        let chat_sq_dir = work_root.join("chat-sqlite");
        fs::create_dir_all(&chat_sq_dir).unwrap();
        let dr = DataRoot::new(&chat_sq_dir);
        let (st, rt) = CanonicalRuntime::open(CanonicalConfig {
            installation_id: InstallationId::from_bytes([0x58; 16]),
            sql: SqlBackendConfig::sqlite_default(dr.clone()),
            blobs: BlobBackendConfig::Local { data_root: dr },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: default_backup_budget(),
        })
        .await
        .unwrap();
        chat_read_profiles.extend(
            run_chat_read_benchmarks_for_store(
                &st,
                "sqlite_wal_full+local_zstd_v1",
                chat_turns,
                chat_reads,
                None,
            )
            .await,
        );
        rt.shutdown().await.unwrap();
        let _ = fs::remove_dir_all(&chat_sq_dir);
    }
    {
        let pg_schema = fixtures.fresh_pg_schema("chat");
        let chat_pg_dir = work_root.join("chat-pg-cas");
        fs::create_dir_all(&chat_pg_dir).unwrap();
        let (st, rt) = CanonicalRuntime::open(CanonicalConfig {
            installation_id: InstallationId::from_bytes([0x59; 16]),
            sql: SqlBackendConfig::postgres_default(fixtures.pg_connect(), &pg_schema),
            blobs: BlobBackendConfig::Local {
                data_root: DataRoot::new(&chat_pg_dir),
            },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: notarium_canonical::config::default_postgres_backup_budget(),
        })
        .await
        .unwrap();
        chat_read_profiles.extend(
            run_chat_read_benchmarks_for_store(
                &st,
                "postgres16_sync+local_zstd_v1",
                chat_turns,
                chat_reads,
                Some((&fixtures, &pg_schema)),
            )
            .await,
        );
        rt.shutdown().await.unwrap();
        fixtures.drop_pg_schema(&pg_schema).await;
        let _ = fs::remove_dir_all(&chat_pg_dir);
    }
    for cp in &chat_read_profiles {
        eprintln!(
            "[D3]   -> {} [{}]: p50={:.1} us, p95={:.1} us, writes={}",
            cp.backend,
            cp.topology,
            cp.latency.p50_us,
            cp.latency.p95_us,
            cp.sql_writes_during_reads
        );
    }

    // 4. Board 10k first-slot moves & Folder 100k-descendant MoveFolder
    eprintln!("[D3] board {board_moves} consecutive first-slot moves...");
    let mut board_first_slot_profiles = Vec::new();
    {
        let b_dir = work_root.join("board-sqlite");
        fs::create_dir_all(&b_dir).unwrap();
        let dr = DataRoot::new(&b_dir);
        let (st, rt) = CanonicalRuntime::open(CanonicalConfig {
            installation_id: InstallationId::from_bytes([0x68; 16]),
            sql: SqlBackendConfig::sqlite_default(dr.clone()),
            blobs: BlobBackendConfig::Local { data_root: dr },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: default_backup_budget(),
        })
        .await
        .unwrap();
        board_first_slot_profiles.push(
            run_board_first_slot_benchmark(&st, "sqlite_wal_full+local_zstd_v1", board_moves).await,
        );
        rt.shutdown().await.unwrap();
        let _ = fs::remove_dir_all(&b_dir);
    }
    {
        let pg_schema = fixtures.fresh_pg_schema("board");
        let b_dir = work_root.join("board-pg-cas");
        fs::create_dir_all(&b_dir).unwrap();
        let (st, rt) = CanonicalRuntime::open(CanonicalConfig {
            installation_id: InstallationId::from_bytes([0x69; 16]),
            sql: SqlBackendConfig::postgres_default(fixtures.pg_connect(), &pg_schema),
            blobs: BlobBackendConfig::Local {
                data_root: DataRoot::new(&b_dir),
            },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: notarium_canonical::config::default_postgres_backup_budget(),
        })
        .await
        .unwrap();
        board_first_slot_profiles.push(
            run_board_first_slot_benchmark(&st, "postgres16_sync+local_zstd_v1", board_moves).await,
        );
        rt.shutdown().await.unwrap();
        fixtures.drop_pg_schema(&pg_schema).await;
        let _ = fs::remove_dir_all(&b_dir);
    }
    for bp in &board_first_slot_profiles {
        eprintln!(
            "[D3]   -> {}: max_rank={}B, rebalances={}, p95={:.1} us",
            bp.backend, bp.max_rank_bytes_observed, bp.pma_rebalance_events, bp.latency.p95_us
        );
    }

    eprintln!(
        "[D3] folder MoveFolder over {} descendants ({folder_moves} moves)...",
        desc_folders + desc_notes
    );
    let mut folder_move_profiles = Vec::new();
    {
        let f_dir = work_root.join("folder-sqlite");
        fs::create_dir_all(&f_dir).unwrap();
        let dr = DataRoot::new(&f_dir);
        let (st, rt) = CanonicalRuntime::open(CanonicalConfig {
            installation_id: InstallationId::from_bytes([0x7A; 16]),
            sql: SqlBackendConfig::sqlite_default(dr.clone()),
            blobs: BlobBackendConfig::Local { data_root: dr },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: default_backup_budget(),
        })
        .await
        .unwrap();
        folder_move_profiles.push(
            run_folder_100k_move_benchmark(
                &st,
                "sqlite_wal_full+local_zstd_v1",
                desc_folders,
                desc_notes,
                folder_moves,
            )
            .await,
        );
        rt.shutdown().await.unwrap();
        let _ = fs::remove_dir_all(&f_dir);
    }
    {
        let pg_schema = fixtures.fresh_pg_schema("folder");
        let f_dir = work_root.join("folder-pg-cas");
        fs::create_dir_all(&f_dir).unwrap();
        let (st, rt) = CanonicalRuntime::open(CanonicalConfig {
            installation_id: InstallationId::from_bytes([0x7B; 16]),
            sql: SqlBackendConfig::postgres_default(fixtures.pg_connect(), &pg_schema),
            blobs: BlobBackendConfig::Local {
                data_root: DataRoot::new(&f_dir),
            },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: notarium_canonical::config::default_postgres_backup_budget(),
        })
        .await
        .unwrap();
        folder_move_profiles.push(
            run_folder_100k_move_benchmark(
                &st,
                "postgres16_sync+local_zstd_v1",
                desc_folders,
                desc_notes,
                folder_moves,
            )
            .await,
        );
        rt.shutdown().await.unwrap();
        fixtures.drop_pg_schema(&pg_schema).await;
        let _ = fs::remove_dir_all(&f_dir);
    }
    for fp in &folder_move_profiles {
        eprintln!(
            "[D3]   -> {}: descendant_writes={}, p95={:.1} us",
            fp.backend, fp.descendant_rows_modified, fp.latency.p95_us
        );
    }

    let paired_backup_pause_profiles =
        run_paired_profiles(&fixtures, &work_root, backup_captures).await;
    let _ = fs::remove_dir_all(&work_root);

    let met_targets = rollback_profiles
        .iter()
        .all(|r| !r.enforce_5ms_budget || r.latency.p95_us < 5_000.0)
        && writer_50w_0r_runs
            .iter()
            .chain(&writer_50w_200r_runs)
            .all(|w| w.throughput_mut_per_sec > 2_000.0)
        && chat_read_profiles
            .iter()
            .all(|c| c.latency.p95_us < 1_000.0)
        && paired_backup_pause_profiles
            .iter()
            .all(|p| p.confirmed_pause_latency.p95_us < 1_000.0);
    let report = D3BenchmarkReport {
        status: if !met_targets {
            "FAIL"
        } else if smoke_mode {
            "SMOKE"
        } else {
            "PASS"
        },
        environment,
        writer_50w_0r_runs,
        writer_50w_200r_runs,
        rollback_profiles,
        chat_read_profiles,
        board_first_slot_profiles,
        folder_move_profiles,
        paired_backup_pause_profiles,
    };

    write_report(&report, &out_file, met_targets);
}
