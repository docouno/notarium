use std::{
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use notarium_core::{
    DomainError,
    auth::{Space, SpaceKind, SpaceLifecycle},
    classes::DocClass,
    epoch::DatabaseWitness,
    error::{PortError, ValidationReason},
    ids::{
        AgentRunId, ContentDigest, FolderId, HistoryIncarnation, InstallationId, LeaseEpoch,
        NoteId, PrincipalId, RequestId, RevisionId, SpaceId, SpaceSeq,
    },
    model::{FolderRef, HistoryScope, Lifecycle, NoteRef, PathTarget},
    ports::{CallBudget, Cancellation, MaintenanceContext, ServicePurpose},
    value::Timestamp,
};
use sqlx::{Connection, PgPool, Row, SqlitePool};
use tokio::sync::Mutex;

use crate::{
    blobs::{
        BlobBackendDriver, BlobOwnerKind, BlobReferenceClaim, activate_and_bind_blob_ref_tx,
        release_owner_blob_refs_tx, s3::S3Transport,
    },
    changes::{BroadcastHub, BroadcastSignal, DEFAULT_BROADCAST_CAPACITY},
    codec::{
        FolderRevisionMetadata, NoteRevisionMetadata, RevisionMetadataEnvelope,
        RevisionMetadataPayload, cancelled_not_committed, deadline_not_committed,
        decode_timestamp_parts, doc_class_to_db, encode_timestamp_parts, i64_to_space_seq,
        internal_not_committed, lifecycle_from_db, lifecycle_to_db, new_prefixed_hex_id,
        new_revision_id, normalize_slug_key, normalize_title_key, now_unix_ms, now_utc_timestamp,
        unavailable_retryable,
    },
    config::{BlobBackendConfig, CanonicalConfig, SqlBackendConfig},
    dialect::{
        DataRootOwnerLock, postgres::open_and_bootstrap_postgres, sqlite::open_and_bootstrap_sqlite,
    },
    sql_exec::BackendConn,
    wal::{SqliteWalCoordinator, WalTelemetrySnapshot},
    writer::{
        BatchEventDraft, CommandIdentitySpec, ItemCommitArtifacts, PreparedWriteIntent,
        WriteCoordinator,
    },
};

#[allow(clippy::large_enum_variant)]
pub(crate) enum SqlDriverState {
    Sqlite {
        writer: Mutex<Option<crate::sqlite_fast::SqliteWriterPair>>,
        fast_read_pool: crate::sqlite_fast::SqliteFastReadPool,
        read_pool: SqlitePool,
        #[allow(dead_code)]
        read_deadline: Duration,
    },
    Postgres {
        pool: PgPool,
        fast_write_conn: std::sync::Mutex<Option<sqlx::pool::PoolConnection<sqlx::Postgres>>>,
        fast_read_conn: std::sync::Mutex<Option<sqlx::pool::PoolConnection<sqlx::Postgres>>>,
        can_cache_fast_conn: bool,
        #[allow(dead_code)]
        schema: String,
        statement_timeout: Duration,
    },
}

#[derive(Clone)]
pub(crate) struct CachedPgHeadSnapshot {
    pub pf: String,
    pub s: String,
    pub sf: String,
    pub t: String,
    pub lc: Lifecycle,
    pub byte_size: u64,
    pub vmask: i32,
    pub dig: Option<ContentDigest>,
}

#[derive(Clone)]
pub(crate) struct CachedPgRollbackTip {
    pub first_run_seq: i64,
    pub max_other_seq: Option<i64>,
    pub pre_rev_id: Option<String>,
}

pub(crate) struct CachedPgImmutableNoteRev {
    pub pre_meta: NoteRevisionMetadata,
    pub normalized_title_fold: String,
    pub canonical_root_meta_msgpack: Vec<u8>,
}

#[derive(Default)]
pub(crate) struct PgImmutableRollbackCache {
    pub space_meta: std::collections::HashMap<
        (SpaceId, HistoryIncarnation),
        (FolderId, notarium_core::auth::SpaceKind),
    >,
    pub revs: std::collections::HashMap<
        (SpaceId, HistoryIncarnation, String),
        Arc<CachedPgImmutableNoteRev>,
    >,
    pub head_snapshots: std::collections::HashMap<
        (SpaceId, HistoryIncarnation, String, String),
        CachedPgHeadSnapshot,
    >,
    pub tips: std::collections::HashMap<
        (SpaceId, HistoryIncarnation, String, String, String),
        CachedPgRollbackTip,
    >,
    pub run_note_counts:
        std::collections::HashMap<(SpaceId, HistoryIncarnation, String, String), i32>,
    pub pubs: std::collections::HashMap<(SpaceId, [u8; 32]), Arc<str>>,
    pub warmed_spaces: std::collections::HashSet<SpaceId>,
}

pub(crate) struct CanonicalInner {
    pub config: CanonicalConfig,
    pub witness: DatabaseWitness,
    pub sql: SqlDriverState,
    pub blobs: BlobBackendDriver,
    pub writer_coord: OnceLock<Arc<WriteCoordinator>>,
    pub wal_coord: OnceLock<Arc<SqliteWalCoordinator>>,
    pub broadcast_hub: BroadcastHub,
    pub board_provider: OnceLock<(
        notarium_core::ports::BoardPlannerAuthority,
        Arc<dyn notarium_core::ports::BoardMutationFactsProvider>,
    )>,
    pub collab_interceptor: OnceLock<Arc<dyn notarium_core::ports::LiveCollabInterceptor>>,
    pub room_fences: Arc<crate::domain::RoomFenceTable>,
    pub job_reads: crate::peers::JobReadRegistry,
    pub pg_imm_cache: Arc<std::sync::RwLock<PgImmutableRollbackCache>>,
    pub backup_spool_override: std::sync::Mutex<Option<std::path::PathBuf>>,
    pub backup_cleanups: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub last_backup_memory_stats:
        std::sync::Mutex<Option<crate::backup::BackupExporterMemoryStats>>,
    pub backup_step_delay_us: std::sync::atomic::AtomicU64,
    pub sqlite_writer_commit_gen: std::sync::atomic::AtomicU64,
    pub sqlite_purge_fence_gen: std::sync::atomic::AtomicU64,
    pub sqlite_has_any_purge_fences: AtomicBool,
    pub sqlite_has_any_space_schemas: AtomicBool,
    pub sqlite_has_any_collab_sessions: AtomicBool,
    pub shutting_down: AtomicBool,
    pub owner_locks: Mutex<Vec<DataRootOwnerLock>>,
}

impl CanonicalInner {
    pub(crate) fn writer(&self) -> Result<&Arc<WriteCoordinator>, PortError> {
        self.writer_coord.get().ok_or_else(|| {
            internal_not_committed(
                "writer_not_initialized",
                "WriteCoordinator was not initialized",
            )
        })
    }

    pub(crate) fn latch_sqlite_aux_tables_populated(&self) {
        self.sqlite_has_any_purge_fences
            .store(true, Ordering::Release);
        self.sqlite_has_any_space_schemas
            .store(true, Ordering::Release);
        self.sqlite_has_any_collab_sessions
            .store(true, Ordering::Release);
    }

    pub(crate) fn clear_pg_immutable_caches(&self) {
        if let Ok(mut g) = self.pg_imm_cache.write() {
            g.space_meta.clear();
            g.revs.clear();
            g.head_snapshots.clear();
            g.tips.clear();
            g.run_note_counts.clear();
            g.pubs.clear();
            g.warmed_spaces.clear();
        }
    }
}

/// Cloneable canonical storage facade. Never exposes raw SQL pools or connections.
#[derive(Clone, Debug)]
struct SqliteSeedTable {
    name: String,
    insert_sql: String,
    rows: Vec<Vec<rusqlite::types::Value>>,
}

#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct SqliteBenchSeed {
    max_space_seq: i64,
    tables: Vec<SqliteSeedTable>,
}

#[derive(Clone)]
pub struct CanonicalStore {
    pub(crate) inner: Arc<CanonicalInner>,
}

impl std::fmt::Debug for CanonicalStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CanonicalStore")
            .field("installation_id", &self.inner.config.installation_id)
            .finish_non_exhaustive()
    }
}

/// Lifecycle owner handle for draining and shutting down canonical storage cleanly.
pub struct CanonicalRuntime {
    inner: Arc<CanonicalInner>,
}

impl std::fmt::Debug for CanonicalRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CanonicalRuntime")
            .field("witness", &self.inner.witness)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct CreateSpaceSpec {
    pub space_id: SpaceId,
    pub incarnation: HistoryIncarnation,
    pub root_folder_id: FolderId,
    pub slug: String,
    pub kind: SpaceKind,
    pub owner: PrincipalId,
    pub active_epoch: LeaseEpoch,
    pub initial_last_seq: SpaceSeq,
    pub created_at: Option<Timestamp>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpaceRecord {
    pub space: Space,
    pub scope: HistoryScope,
    pub root_folder_id: FolderId,
    pub slug: String,
    pub owner: PrincipalId,
    pub active_epoch: LeaseEpoch,
    pub last_seq: SpaceSeq,
    pub created_at: Timestamp,
}

#[derive(Clone, Debug)]
pub struct CreateFolderSpec {
    pub scope: HistoryScope,
    pub active_epoch: LeaseEpoch,
    pub folder_id: FolderId,
    pub parent: Option<FolderId>,
    pub slug: String,
    pub display_name: String,
    pub is_project: bool,
    pub project_slug: Option<String>,
    pub actor: PrincipalId,
    pub timestamp: Option<Timestamp>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredRevisionRecord {
    pub revision_id: RevisionId,
    pub space_seq: SpaceSeq,
    pub visibility_seq: SpaceSeq,
    pub content_digest: Option<ContentDigest>,
    pub metadata: RevisionMetadataEnvelope,
    pub actor_id: PrincipalId,
    pub agent_run_id: Option<AgentRunId>,
    pub restored_from_rev_id: Option<RevisionId>,
    pub created_at: Timestamp,
}

impl CanonicalRuntime {
    pub async fn open(config: CanonicalConfig) -> Result<(CanonicalStore, Self), PortError> {
        Self::open_with_s3_transport(config, None).await
    }

    pub async fn open_with_s3_transport(
        config: CanonicalConfig,
        custom_s3_transport: Option<Arc<dyn S3Transport>>,
    ) -> Result<(CanonicalStore, Self), PortError> {
        let mut locks = Vec::new();
        match (&config.sql, &config.blobs) {
            (
                SqlBackendConfig::Sqlite { data_root, .. },
                BlobBackendConfig::Local {
                    data_root: blob_root,
                },
            ) => {
                locks.push(DataRootOwnerLock::acquire(data_root)?);
                if blob_root != data_root {
                    locks.push(DataRootOwnerLock::acquire(blob_root)?);
                }
            }
            (SqlBackendConfig::Sqlite { data_root, .. }, BlobBackendConfig::S3(_)) => {
                locks.push(DataRootOwnerLock::acquire(data_root)?);
            }
            (SqlBackendConfig::Postgres { .. }, BlobBackendConfig::Local { data_root }) => {
                locks.push(DataRootOwnerLock::acquire(data_root)?);
            }
            (SqlBackendConfig::Postgres { .. }, BlobBackendConfig::S3(_)) => {}
        }

        let blobs = BlobBackendDriver::open(&config.blobs, custom_s3_transport).await?;

        let (sql, witness, init_has_purge_fences, init_has_space_schemas, init_has_collab_sessions) =
            match &config.sql {
                SqlBackendConfig::Sqlite {
                    data_root,
                    read_pool_size,
                    read_deadline,
                    ..
                } => {
                    let (writer, rusqlite_writer, fast_readers, read_pool, witness) =
                        open_and_bootstrap_sqlite(
                            data_root,
                            &config.installation_id,
                            *read_pool_size,
                        )
                        .await?;
                    let has_pf = rusqlite_writer
                        .query_row(
                            "SELECT 1 FROM revision_purge_fences LIMIT 1",
                            [],
                            |_| Ok(()),
                        )
                        .is_ok();
                    let has_ss = rusqlite_writer
                        .query_row("SELECT 1 FROM space_field_schemas LIMIT 1", [], |_| Ok(()))
                        .is_ok();
                    let has_cs = rusqlite_writer
                        .query_row("SELECT 1 FROM collab_sessions LIMIT 1", [], |_| Ok(()))
                        .is_ok();
                    let db_path = data_root.canonical();
                    (
                        SqlDriverState::Sqlite {
                            writer: Mutex::new(Some(crate::sqlite_fast::SqliteWriterPair {
                                sqlx_conn: writer,
                                rusqlite_conn: Some(rusqlite_writer),
                                db_path: db_path.clone(),
                            })),
                            fast_read_pool: crate::sqlite_fast::SqliteFastReadPool::new(
                                db_path,
                                fast_readers,
                            ),
                            read_pool,
                            read_deadline: *read_deadline,
                        },
                        witness,
                        has_pf,
                        has_ss,
                        has_cs,
                    )
                }
                SqlBackendConfig::Postgres {
                    connect,
                    schema,
                    pool_size,
                    statement_timeout,
                } => {
                    let (pool, witness, validated_schema) = open_and_bootstrap_postgres(
                        connect,
                        schema,
                        &config.installation_id,
                        *pool_size,
                    )
                    .await?;
                    (
                        SqlDriverState::Postgres {
                            pool,
                            fast_write_conn: std::sync::Mutex::new(None),
                            fast_read_conn: std::sync::Mutex::new(None),
                            can_cache_fast_conn: *pool_size > 2,
                            schema: validated_schema,
                            statement_timeout: *statement_timeout,
                        },
                        witness,
                        true,
                        true,
                        true,
                    )
                }
            };

        let inner = Arc::new(CanonicalInner {
            config,
            witness,
            sql,
            blobs,
            writer_coord: OnceLock::new(),
            wal_coord: OnceLock::new(),
            broadcast_hub: BroadcastHub::new(DEFAULT_BROADCAST_CAPACITY),
            board_provider: OnceLock::new(),
            collab_interceptor: OnceLock::new(),
            room_fences: Arc::new(crate::domain::RoomFenceTable::default()),
            job_reads: crate::peers::JobReadRegistry::default(),
            pg_imm_cache: Arc::new(std::sync::RwLock::new(PgImmutableRollbackCache::default())),
            backup_spool_override: std::sync::Mutex::new(None),
            backup_cleanups: std::sync::Mutex::new(Vec::new()),
            last_backup_memory_stats: std::sync::Mutex::new(None),
            backup_step_delay_us: std::sync::atomic::AtomicU64::new(0),
            sqlite_writer_commit_gen: std::sync::atomic::AtomicU64::new(0),
            sqlite_purge_fence_gen: std::sync::atomic::AtomicU64::new(0),
            sqlite_has_any_purge_fences: AtomicBool::new(init_has_purge_fences),
            sqlite_has_any_space_schemas: AtomicBool::new(init_has_space_schemas),
            sqlite_has_any_collab_sessions: AtomicBool::new(init_has_collab_sessions),
            shutting_down: AtomicBool::new(false),
            owner_locks: Mutex::new(locks),
        });

        let coord = WriteCoordinator::start(&inner);
        let _ = inner.writer_coord.set(coord);

        if let SqlBackendConfig::Sqlite {
            data_root,
            read_deadline,
            passive_checkpoint_interval,
            wal_soft_watermark_bytes,
            wal_high_watermark_bytes,
            wal_reset_cycle_deadline,
            ..
        } = &inner.config.sql
        {
            let wal = SqliteWalCoordinator::start(
                &inner,
                &data_root.canonical(),
                *read_deadline,
                *passive_checkpoint_interval,
                *wal_soft_watermark_bytes,
                *wal_high_watermark_bytes,
                *wal_reset_cycle_deadline,
            );
            let _ = inner.wal_coord.set(wal);
        }

        let store = CanonicalStore {
            inner: Arc::clone(&inner),
        };
        crate::peers::reconcile_collab_fences_on_startup(&store).await?;
        crate::domain::purge::resume_pending_purges_on_startup(&store).await?;

        Ok((store, Self { inner }))
    }

    pub fn witness(&self) -> &DatabaseWitness {
        &self.inner.witness
    }

    pub fn installation_id(&self) -> &InstallationId {
        &self.inner.config.installation_id
    }

    pub async fn shutdown(self) -> Result<(), PortError> {
        let pending_backup_cleanups: Vec<tokio::task::JoinHandle<()>> = {
            let mut guard = self
                .inner
                .backup_cleanups
                .lock()
                .expect("backup cleanups mutex");
            std::mem::take(&mut *guard)
        };
        for handle in pending_backup_cleanups {
            let _ = handle.await;
        }
        if let Some(coord) = self.inner.writer_coord.get() {
            coord.drain_and_shutdown().await;
        }
        if let Some(wal) = self.inner.wal_coord.get() {
            wal.shutdown().await;
        }
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        match &self.inner.sql {
            SqlDriverState::Sqlite {
                writer,
                fast_read_pool,
                read_pool,
                ..
            } => {
                fast_read_pool.close_all().await;
                read_pool.close().await;
                let mut guard = writer.lock().await;
                if let Some(mut pair) = guard.take() {
                    if let Some(rconn) = pair.rusqlite_conn.take() {
                        let _ = tokio::task::spawn_blocking(move || {
                            let _ = rconn.close();
                        })
                        .await;
                    }
                    let _ = pair.sqlx_conn.close().await;
                }
            }
            SqlDriverState::Postgres {
                pool,
                fast_write_conn,
                fast_read_conn,
                ..
            } => {
                let cached_w = fast_write_conn
                    .lock()
                    .expect("pg fast_write_conn mutex")
                    .take();
                let cached_r = fast_read_conn
                    .lock()
                    .expect("pg fast_read_conn mutex")
                    .take();
                drop(cached_w);
                drop(cached_r);
                pool.close().await;
            }
        }
        let mut locks = self.inner.owner_locks.lock().await;
        locks.clear();
        if let BlobBackendDriver::Local(local) = &self.inner.blobs {
            local.clear_cached_dirs();
        }
        Ok(())
    }
}

impl CanonicalStore {
    pub fn installation_id(&self) -> &InstallationId {
        &self.inner.config.installation_id
    }

    pub(crate) fn is_sqlite_local(&self) -> bool {
        matches!(
            (&self.inner.sql, &self.inner.blobs),
            (SqlDriverState::Sqlite { .. }, BlobBackendDriver::Local(_))
        )
    }

    pub async fn read_space(&self, space_id: &SpaceId) -> Result<SpaceRecord, PortError> {
        let sid = space_id.clone();
        self.with_read_tx(|tx| Box::pin(async move { load_space_record(tx, &sid).await }))
            .await
    }

    pub(crate) async fn read_space_fast_or_pool(
        &self,
        space_id: &SpaceId,
        budget: Option<&CallBudget>,
    ) -> Result<SpaceRecord, PortError> {
        if let SqlDriverState::Sqlite { fast_read_pool, .. } = &self.inner.sql {
            self.ensure_open()?;
            let wal = self.inner.wal_coord.get().ok_or_else(|| {
                internal_not_committed(
                    "sqlite_wal_coord_missing",
                    "SqliteWalCoordinator not initialized",
                )
            })?;
            let sid = space_id.clone();
            return fast_read_pool
                .with_read_conn(wal, budget, move |conn| {
                    crate::sqlite_fast::load_space_record_rusqlite(conn, &sid)
                })
                .await;
        }
        let sid = space_id.clone();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move { load_space_record(tx, &sid).await })
        })
        .await
    }

    /// Commits an explicit CAS reference claim through `WriteBatchActor`, ensuring local directory `fsync`
    /// and atomic `blob_catalog` / `blob_publications` / `blob_references` activation.
    pub async fn commit_blob_reference_claim(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        claim: BlobReferenceClaim,
        idempotency: Option<CommandIdentitySpec>,
        budget: Option<CallBudget>,
    ) -> Result<SpaceSeq, PortError> {
        let mut random_req = [0u8; 16];
        getrandom::fill(&mut random_req)
            .map_err(|err| internal_not_committed("csprng_req_id", err.to_string()))?;
        let eff_budget = budget.unwrap_or(CallBudget {
            request: RequestId::from_bytes(random_req),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        });
        let staged_bytes = claim.ticket.compressed_size;
        let cmd_id = new_prefixed_hex_id("cmd_")?;
        let scope_cl = scope.clone();

        let intent = PreparedWriteIntent {
            scope: scope_cl,
            active_epoch,
            idempotency,
            source_note_ids: Vec::new(),
            staged_bytes,
            required_semantic_cut: None,
            execute: Box::new(move |tx, ctx| {
                Box::pin(async move {
                    let seq = ctx.alloc_next_seq()?;
                    activate_and_bind_blob_ref_tx(tx, ctx.active_epoch, &claim, seq).await?;
                    let owner_id = claim.owner_id.clone();
                    let ev_rev = new_revision_id()?;
                    ctx.record_staged_ticket(claim.ticket);
                    let resp_bytes = Self::encode_command_outcome(&seq.get())?;
                    Ok(ItemCommitArtifacts {
                        command_id: cmd_id,
                        command_kind: "bind_blob_ref".to_owned(),
                        events: vec![BatchEventDraft {
                            space_seq: seq,
                            entity_type: "note".to_owned(),
                            entity_id: owner_id,
                            op_kind: "edit".to_owned(),
                            rev_id: ev_rev,
                            lifecycle: Lifecycle::Active,
                            doc_class: None,
                        }],
                        change_payload: None,
                        receipt_detail_blob: None,
                        receipt_sanitized_blob: resp_bytes.clone(),
                        receipt_owner_note_ids: Vec::new(),
                        response_bytes: resp_bytes,
                    })
                })
            }),
        };

        let seq_u64: u64 = self.submit_write_command(&eff_budget, intent).await?;
        Ok(SpaceSeq::new(seq_u64)?)
    }

    /// Releases all CAS references owned by `(owner_kind, owner_id)` inside `WriteBatchActor`,
    /// returning digests whose reachable reference count dropped to `0`.
    pub async fn release_blob_owner_references(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        owner_kind: BlobOwnerKind,
        owner_id: &str,
    ) -> Result<Vec<ContentDigest>, PortError> {
        let mut random_req = [0u8; 16];
        getrandom::fill(&mut random_req)
            .map_err(|err| internal_not_committed("csprng_req_id", err.to_string()))?;
        let eff_budget = CallBudget {
            request: RequestId::from_bytes(random_req),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        };
        let cmd_id = new_prefixed_hex_id("cmd_")?;
        let owner_id_owned = owner_id.to_owned();
        let scope_cl = scope.clone();

        let intent = PreparedWriteIntent {
            scope: scope_cl,
            active_epoch,
            idempotency: None,
            source_note_ids: Vec::new(),
            staged_bytes: 0,
            required_semantic_cut: None,
            execute: Box::new(move |tx, ctx| {
                Box::pin(async move {
                    let seq = ctx.alloc_next_seq()?;
                    let zero_digests = release_owner_blob_refs_tx(
                        tx,
                        &ctx.scope.space_id,
                        owner_kind,
                        &owner_id_owned,
                    )
                    .await?;
                    let hex_list: Vec<String> = zero_digests.iter().map(|d| d.to_hex()).collect();
                    let ev_rev = new_revision_id()?;
                    let resp_bytes = Self::encode_command_outcome(&hex_list)?;
                    Ok(ItemCommitArtifacts {
                        command_id: cmd_id,
                        command_kind: "release_blob_refs".to_owned(),
                        events: vec![BatchEventDraft {
                            space_seq: seq,
                            entity_type: "note".to_owned(),
                            entity_id: owner_id_owned,
                            op_kind: "trash".to_owned(),
                            rev_id: ev_rev,
                            lifecycle: Lifecycle::Trashed,
                            doc_class: None,
                        }],
                        change_payload: None,
                        receipt_detail_blob: None,
                        receipt_sanitized_blob: resp_bytes.clone(),
                        receipt_owner_note_ids: Vec::new(),
                        response_bytes: resp_bytes,
                    })
                })
            }),
        };

        let hex_list: Vec<String> = self.submit_write_command(&eff_budget, intent).await?;
        let mut digests = Vec::with_capacity(hex_list.len());
        for h in hex_list {
            let bytes = hex::decode(&h)
                .map_err(|err| internal_not_committed("decode_zero_digest_hex", err.to_string()))?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| internal_not_committed("decode_zero_digest_len", "digest != 32B"))?;
            digests.push(ContentDigest::from_bytes(arr));
        }
        Ok(digests)
    }

    pub(crate) fn ensure_open(&self) -> Result<(), PortError> {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(unavailable_retryable(
                "canonical_shutting_down",
                "canonical runtime is shutting down",
                Duration::from_millis(100),
            ));
        }
        Ok(())
    }

    pub(crate) async fn with_fenced_auxiliary_write_tx<F, T>(&self, op: F) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        self.with_write_tx(op).await
    }

    pub(crate) async fn with_write_tx<F, T>(&self, op: F) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        self.ensure_open()?;
        let _commit_gate = if let Some(writer) = self.inner.writer_coord.get() {
            Some(writer.acquire_commit_read_guard().await)
        } else {
            None
        };
        self.with_write_tx_unfenced(op).await
    }

    pub(crate) async fn with_write_tx_unfenced<F, T>(&self, op: F) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        self.ensure_open()?;
        match &self.inner.sql {
            SqlDriverState::Sqlite { writer, .. } => {
                let mut guard = writer.lock().await;
                let pair = guard.as_mut().ok_or_else(|| {
                    unavailable_retryable(
                        "sqlite_writer_closed",
                        "SQLite writer connection closed",
                        Duration::from_millis(100),
                    )
                })?;
                let mut backend = BackendConn::Sqlite(&mut pair.sqlx_conn);
                backend.begin_write().await?;
                match op(&mut backend).await {
                    Ok(value) => {
                        backend.commit_write().await?;
                        self.inner
                            .sqlite_writer_commit_gen
                            .fetch_add(1, Ordering::Release);
                        self.inner
                            .sqlite_purge_fence_gen
                            .fetch_add(1, Ordering::Release);
                        if let Some(wal) = self.inner.wal_coord.get() {
                            wal.note_writer_commit();
                        }
                        Ok(value)
                    }
                    Err(err) => {
                        backend.rollback_best_effort().await;
                        Err(err)
                    }
                }
            }
            SqlDriverState::Postgres { pool, .. } => {
                let mut pooled = pool.acquire().await.map_err(|err| {
                    unavailable_retryable(
                        "pg_acquire_write",
                        err.to_string(),
                        Duration::from_millis(50),
                    )
                })?;
                let conn: &mut sqlx::PgConnection = &mut pooled;
                let mut backend = BackendConn::Postgres(conn);
                backend.begin_write().await?;
                match op(&mut backend).await {
                    Ok(value) => {
                        backend.commit_write().await?;
                        self.inner
                            .sqlite_writer_commit_gen
                            .fetch_add(1, Ordering::Release);
                        self.inner
                            .sqlite_purge_fence_gen
                            .fetch_add(1, Ordering::Release);
                        if let Some(wal) = self.inner.wal_coord.get() {
                            wal.note_writer_commit();
                        }
                        Ok(value)
                    }
                    Err(err) => {
                        backend.rollback_best_effort().await;
                        Err(err)
                    }
                }
            }
        }
    }

    pub fn wal_telemetry(&self) -> Option<WalTelemetrySnapshot> {
        self.inner.wal_coord.get().map(|w| w.telemetry())
    }

    pub async fn run_wal_maintenance_now(&self, force_reset: bool) {
        if let Some(wal) = self.inner.wal_coord.get() {
            wal.run_maintenance_tick(&self.inner, force_reset).await;
        }
    }

    #[doc(hidden)]
    pub async fn execute_diagnostic_read_sql_for_test(
        &self,
        budget: Option<&CallBudget>,
        sql: &str,
    ) -> Result<i64, PortError> {
        let owned = sql.to_owned();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(sqlx::AssertSqlSafe(owned))
                        .fetch_one(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("diag_sqlite_read", err.to_string())),
                    BackendConn::Postgres(conn) => sqlx::query_scalar(sqlx::AssertSqlSafe(owned))
                        .fetch_one(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("diag_pg_read", err.to_string())),
                }
            })
        })
        .await
    }

    #[doc(hidden)]
    pub async fn execute_diagnostic_write_sql_for_test(&self, sql: &str) -> Result<u64, PortError> {
        self.inner.latch_sqlite_aux_tables_populated();
        self.inner.clear_pg_immutable_caches();
        let owned = sql.to_owned();
        self.with_write_tx(|tx| {
            Box::pin(async move {
                match tx {
                    BackendConn::Sqlite(conn) => sqlx::query(sqlx::AssertSqlSafe(owned))
                        .execute(&mut **conn)
                        .await
                        .map(|r| r.rows_affected())
                        .map_err(|err| {
                            internal_not_committed("diag_sqlite_write", err.to_string())
                        }),
                    BackendConn::Postgres(conn) => sqlx::query(sqlx::AssertSqlSafe(owned))
                        .execute(&mut **conn)
                        .await
                        .map(|r| r.rows_affected())
                        .map_err(|err| internal_not_committed("diag_pg_write", err.to_string())),
                }
            })
        })
        .await
    }

    #[doc(hidden)]
    pub async fn snapshot_sqlite_tables_for_bench(&self) -> Result<SqliteBenchSeed, PortError> {
        self.ensure_open()?;
        let SqlDriverState::Sqlite { writer, .. } = &self.inner.sql else {
            return Err(internal_not_committed(
                "bench_seed_not_sqlite",
                "expected SQLite backend",
            ));
        };
        let mut guard = writer.lock().await;
        let pair = guard.as_mut().ok_or_else(|| {
            unavailable_retryable(
                "sqlite_writer_closed",
                "SQLite writer connection closed",
                Duration::from_millis(50),
            )
        })?;
        let rconn = pair.rusqlite_conn.take().ok_or_else(|| {
            internal_not_committed("sqlite_rconn_missing", "rusqlite writer connection missing")
        })?;
        let (rconn, res) = tokio::task::spawn_blocking(move || {
            let out: Result<SqliteBenchSeed, PortError> = (|| {
                let mut tables =
                    Vec::with_capacity(crate::schema::manifest::CANONICAL_TABLES.len());
                for tspec in crate::schema::manifest::CANONICAL_TABLES {
                    let col_names: Vec<String> =
                        tspec.columns.iter().map(|c| c.name.to_owned()).collect();
                    let select_sql = format!(
                        "SELECT {} FROM \"{}\"",
                        col_names
                            .iter()
                            .map(|c| format!("\"{c}\""))
                            .collect::<Vec<_>>()
                            .join(", "),
                        tspec.name
                    );
                    let mut stmt = rconn
                        .prepare(&select_sql)
                        .map_err(|e| internal_not_committed("bench_seed_prepare", e.to_string()))?;
                    let ncols = col_names.len();
                    let mut rows_iter = stmt
                        .query([])
                        .map_err(|e| internal_not_committed("bench_seed_query", e.to_string()))?;
                    let mut captured_rows = Vec::new();
                    while let Some(row) = rows_iter
                        .next()
                        .map_err(|e| internal_not_committed("bench_seed_next", e.to_string()))?
                    {
                        let mut vals = Vec::with_capacity(ncols);
                        for idx in 0..ncols {
                            let v: rusqlite::types::Value = row.get(idx).map_err(|e| {
                                internal_not_committed("bench_seed_val", e.to_string())
                            })?;
                            vals.push(v);
                        }
                        captured_rows.push(vals);
                    }
                    let insert_sql = if col_names.is_empty() {
                        String::new()
                    } else {
                        let cols_joined = col_names
                            .iter()
                            .map(|c| format!("\"{c}\""))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let placeholders = std::iter::repeat_n("?", ncols)
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!(
                            "INSERT INTO \"{}\" ({cols_joined}) VALUES ({placeholders})",
                            tspec.name
                        )
                    };
                    tables.push(SqliteSeedTable {
                        name: tspec.name.to_owned(),
                        insert_sql,
                        rows: captured_rows,
                    });
                }
                let max_space_seq: i64 = rconn
                    .query_row("SELECT COALESCE(MAX(last_seq), 0) FROM spaces", [], |r| {
                        r.get(0)
                    })
                    .map_err(|e| internal_not_committed("bench_seed_max_seq", e.to_string()))?;
                Ok(SqliteBenchSeed {
                    max_space_seq,
                    tables,
                })
            })();
            (rconn, out)
        })
        .await
        .map_err(|e| internal_not_committed("bench_seed_join", e.to_string()))?;
        pair.rusqlite_conn = Some(rconn);
        res
    }

    #[doc(hidden)]
    pub async fn restore_sqlite_tables_for_bench(
        &self,
        seed: &SqliteBenchSeed,
    ) -> Result<(), PortError> {
        self.ensure_open()?;
        let _maint_guard = match self.inner.wal_coord.get() {
            Some(w) => Some(w.lock_maintenance().await),
            None => None,
        };
        let _commit_guard = self.inner.writer()?.acquire_commit_read_guard().await;
        let SqlDriverState::Sqlite { writer, .. } = &self.inner.sql else {
            return Err(internal_not_committed(
                "bench_restore_not_sqlite",
                "expected SQLite backend",
            ));
        };
        let mut guard = writer.lock().await;
        let pair = guard.as_mut().ok_or_else(|| {
            unavailable_retryable(
                "sqlite_writer_closed",
                "SQLite writer connection closed",
                Duration::from_millis(50),
            )
        })?;
        let rconn = pair.rusqlite_conn.take().ok_or_else(|| {
            internal_not_committed("bench_restore_no_rconn", "rusqlite handle missing")
        })?;
        let seed_cl = seed.clone();
        let (rconn, res) = tokio::task::spawn_blocking(move || {
            let out = (|| -> Result<(), PortError> {
                // Reset directly on `pair.rusqlite_conn` without toggling any `PRAGMA`s so both
                // its SQLite `PCache` (zero `pager_reset`) and prepared statement cache stay hot.
                let seq = seed_cl.max_space_seq;
                let prune_sql = format!(
                    "BEGIN IMMEDIATE;
                     DELETE FROM payload_owners
                         WHERE payload_id IN (SELECT payload_id FROM change_payloads WHERE created_seq > {seq})
                            OR payload_kind = 'command_receipt';
                     DELETE FROM command_receipts WHERE canonical_seq > {seq};
                     DELETE FROM change_log WHERE space_seq > {seq};
                     DELETE FROM change_commands WHERE first_seq > {seq};
                     DELETE FROM change_payloads WHERE created_seq > {seq};
                     DELETE FROM blob_references WHERE created_seq > {seq};
                     DELETE FROM revisions WHERE space_seq > {seq};
                     DELETE FROM board_move_history WHERE command_end_seq > {seq};
                     DELETE FROM view_rank_overlays;"
                );
                rconn
                    .execute_batch(&prune_sql)
                    .map_err(|e| internal_not_committed("bench_restore_begin", e.to_string()))?;

                for tbl in &seed_cl.tables {
                    match tbl.name.as_str() {
                        "blob_catalog" => {
                            let mut ustmt = rconn
                                .prepare_cached(
                                    "UPDATE blob_catalog SET ref_count = ?1
                                     WHERE space_id = ?2 AND content_blake3 = ?3 AND ref_count <> ?1",
                                )
                                .map_err(|e| {
                                    internal_not_committed("bench_restore_bc_prep", e.to_string())
                                })?;
                            for row in &tbl.rows {
                                ustmt
                                    .execute(rusqlite::params![&row[4], &row[0], &row[1]])
                                    .map_err(|e| {
                                        internal_not_committed(
                                            "bench_restore_bc_upd",
                                            e.to_string(),
                                        )
                                    })?;
                            }
                        }
                        "spaces" => {
                            let mut ustmt = rconn
                                .prepare_cached(
                                    "UPDATE spaces SET active_epoch = ?1, last_seq = ?2
                                     WHERE space_id = ?3 AND (active_epoch <> ?1 OR last_seq <> ?2)",
                                )
                                .map_err(|e| {
                                    internal_not_committed("bench_restore_sp_prep", e.to_string())
                                })?;
                            for row in &tbl.rows {
                                ustmt
                                    .execute(rusqlite::params![&row[8], &row[9], &row[0]])
                                    .map_err(|e| {
                                        internal_not_committed(
                                            "bench_restore_sp_upd",
                                            e.to_string(),
                                        )
                                    })?;
                            }
                        }
                        "agent_run_heads" => {
                            let mut ustmt = rconn
                                .prepare_cached(
                                    "UPDATE agent_run_heads
                                     SET run_revision = ?1, last_seq = ?2, updated_at_sec = ?3, updated_at_nsec = ?4
                                     WHERE space_id = ?5 AND run_id = ?6 AND last_seq <> ?2",
                                )
                                .map_err(|e| {
                                    internal_not_committed("bench_restore_ar_prep", e.to_string())
                                })?;
                            for row in &tbl.rows {
                                ustmt
                                    .execute(rusqlite::params![
                                        &row[3], &row[4], &row[5], &row[6], &row[0], &row[2]
                                    ])
                                    .map_err(|e| {
                                        internal_not_committed(
                                            "bench_restore_ar_upd",
                                            e.to_string(),
                                        )
                                    })?;
                            }
                        }
                        "note_heads" => {
                            let mut ustmt = rconn
                                .prepare_cached(
                                    "UPDATE note_heads
                                     SET parent_folder_id = ?3, slug = ?4, slug_fold = ?5,
                                         title = ?6, title_fold = ?7, doc_class = ?8,
                                         ability_id = ?9, head_rev_id = ?10, content_blake3 = ?11,
                                         byte_size = ?12, lifecycle_state = ?13, visibility_mask = ?14,
                                         settlement_successor_id = ?15, updated_seq = ?16,
                                         updated_at_sec = ?17, updated_at_nsec = ?18, last_actor_id = ?19
                                     WHERE space_id = ?1 AND note_id = ?2 AND updated_seq > ?20",
                                )
                                .map_err(|e| {
                                    internal_not_committed("bench_restore_nh_prep", e.to_string())
                                })?;
                            for want_active in [false, true] {
                                for row in &tbl.rows {
                                    let is_active = matches!(
                                        &row[12],
                                        rusqlite::types::Value::Text(s) if s == "active"
                                    );
                                    if is_active != want_active {
                                        continue;
                                    }
                                    ustmt
                                        .execute(rusqlite::params![
                                            &row[0], &row[1], &row[2], &row[3], &row[4], &row[5],
                                            &row[6], &row[7], &row[8], &row[9], &row[10], &row[11],
                                            &row[12], &row[13], &row[14], &row[16], &row[19],
                                            &row[20], &row[21], seq
                                        ])
                                        .map_err(|e| {
                                            internal_not_committed(
                                                "bench_restore_nh_upd",
                                                e.to_string(),
                                            )
                                        })?;
                                }
                            }
                        }
                        "view_rank_overlays" if !tbl.rows.is_empty() => {
                            let mut stmt = rconn.prepare_cached(&tbl.insert_sql).map_err(|e| {
                                internal_not_committed("bench_restore_vro_prep", e.to_string())
                            })?;
                            for row in &tbl.rows {
                                stmt.execute(rusqlite::params_from_iter(row.iter()))
                                    .map_err(|e| {
                                        internal_not_committed(
                                            "bench_restore_vro_ins",
                                            e.to_string(),
                                        )
                                    })?;
                            }
                        }
                        _ => {}
                    }
                }
                rconn
                    .execute_batch("COMMIT;")
                    .map_err(|e| internal_not_committed("bench_restore_commit", e.to_string()))?;
                Ok(())
            })();
            if out.is_err() {
                let _ = rconn.execute_batch("ROLLBACK;");
            }
            (rconn, out)
        })
        .await
        .map_err(|e| internal_not_committed("bench_restore_join", e.to_string()))?;
        pair.rusqlite_conn = Some(rconn);
        res?;
        drop(guard);
        let mut has_pf = false;
        let mut has_ss = false;
        let mut has_cs = false;
        for tbl in &seed.tables {
            if !tbl.rows.is_empty() {
                match tbl.name.as_str() {
                    "revision_purge_fences" => has_pf = true,
                    "space_field_schemas" => has_ss = true,
                    "collab_sessions" => has_cs = true,
                    _ => {}
                }
            }
        }
        self.inner
            .sqlite_has_any_purge_fences
            .store(has_pf, Ordering::Release);
        self.inner
            .sqlite_has_any_space_schemas
            .store(has_ss, Ordering::Release);
        self.inner
            .sqlite_has_any_collab_sessions
            .store(has_cs, Ordering::Release);
        self.inner
            .sqlite_writer_commit_gen
            .fetch_add(1, Ordering::Release);
        Ok(())
    }

    #[doc(hidden)]
    pub async fn restart_sqlite_wal_for_bench(&self) -> Result<(), PortError> {
        self.prewarm_and_restart_sqlite_wal_for_bench(0).await
    }

    #[doc(hidden)]
    pub async fn prewarm_and_restart_sqlite_wal_for_bench(
        &self,
        min_wal_bytes: usize,
    ) -> Result<(), PortError> {
        self.ensure_open()?;
        let _maint_guard = match self.inner.wal_coord.get() {
            Some(w) => Some(w.lock_maintenance().await),
            None => None,
        };
        let _commit_guard = self.inner.writer()?.acquire_commit_read_guard().await;
        let SqlDriverState::Sqlite { writer, .. } = &self.inner.sql else {
            return Err(internal_not_committed(
                "bench_wal_restart_not_sqlite",
                "expected SQLite backend",
            ));
        };
        let mut guard = writer.lock().await;
        let pair = guard.as_mut().ok_or_else(|| {
            unavailable_retryable(
                "sqlite_writer_closed",
                "SQLite writer connection closed",
                Duration::from_millis(50),
            )
        })?;
        let db_path = pair.db_path.clone();
        let rconn = pair.rusqlite_conn.take().ok_or_else(|| {
            internal_not_committed("bench_wal_no_rconn", "rusqlite handle missing")
        })?;
        let (rconn, res) = tokio::task::spawn_blocking(move || {
            let out = (|| -> Result<(), PortError> {
                let target_journal_limit = i64::try_from(min_wal_bytes)
                    .unwrap_or(crate::dialect::sqlite::SQLITE_JOURNAL_SIZE_LIMIT_BYTES)
                    .max(crate::dialect::sqlite::SQLITE_JOURNAL_SIZE_LIMIT_BYTES);
                rconn
                    .execute_batch(&format!(
                        "PRAGMA journal_size_limit = {target_journal_limit};
                         PRAGMA wal_checkpoint(RESTART);
                         BEGIN IMMEDIATE;
                         UPDATE schema_meta SET schema_version = schema_version WHERE singleton_id = 1;
                         COMMIT;"
                    ))
                    .map_err(|e| internal_not_committed("bench_wal_restart", e.to_string()))?;

                let mut wal_os = db_path.as_os_str().to_os_string();
                wal_os.push("-wal");
                let wal_path = std::path::PathBuf::from(wal_os);
                if let Ok(wf) = std::fs::File::open(&wal_path) {
                    let _ = wf.sync_all();
                }
                if let Ok(df) = std::fs::File::open(&db_path) {
                    let _ = df.sync_all();
                }
                Ok(())
            })();
            if out.is_err() {
                let _ = rconn.execute_batch("ROLLBACK;");
            }
            (rconn, out)
        })
        .await
        .map_err(|e| internal_not_committed("bench_wal_restart_join", e.to_string()))?;
        pair.rusqlite_conn = Some(rconn);
        drop(guard);
        if res.is_ok()
            && let Some(wal) = self.inner.wal_coord.get()
        {
            wal.note_external_wal_restart();
        }
        res
    }

    pub(crate) fn is_postgres(&self) -> bool {
        matches!(&self.inner.sql, SqlDriverState::Postgres { .. })
    }

    pub(crate) async fn with_pg_autocommit_read_budget<F, T>(
        &self,
        budget: Option<&CallBudget>,
        op: F,
    ) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut sqlx::PgConnection) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        self.ensure_open()?;
        let SqlDriverState::Postgres {
            pool,
            fast_read_conn,
            can_cache_fast_conn,
            statement_timeout,
            ..
        } = &self.inner.sql
        else {
            return Err(internal_not_committed(
                "pg_autocommit_wrong_backend",
                "expected PostgreSQL backend",
            ));
        };

        if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
            return Err(cancelled_not_committed(
                "pg_read_cancelled_pre_acquire",
                "PostgreSQL read cancelled before pool acquire",
            ));
        }
        let caller_rem = budget.map(|b| b.remaining).unwrap_or(*statement_timeout);
        if caller_rem.is_zero() {
            return Err(deadline_not_committed(
                "pg_read_zero_budget",
                "PostgreSQL read call budget expired",
            ));
        }
        let eff_timeout = caller_rem.min(*statement_timeout);
        let deadline_tokio = tokio::time::Instant::now() + eff_timeout;

        let cached_opt = if *can_cache_fast_conn {
            fast_read_conn
                .lock()
                .expect("pg fast_read_conn mutex")
                .take()
        } else {
            None
        };
        let mut pooled = match cached_opt {
            Some(c) => c,
            None => tokio::select! {
                res = pool.acquire() => res.map_err(|err| {
                    unavailable_retryable(
                        "pg_acquire_read",
                        err.to_string(),
                        Duration::from_millis(50),
                    )
                })?,
                _ = tokio::time::sleep_until(deadline_tokio) => {
                    return Err(deadline_not_committed(
                        "pg_acquire_read_deadline",
                        "deadline exceeded acquiring PostgreSQL read connection",
                    ));
                }
            },
        };

        let run_res: Result<T, PortError> = {
            let conn: &mut sqlx::PgConnection = &mut pooled;
            match tokio::time::timeout_at(deadline_tokio, op(conn)).await {
                Ok(res) => res,
                Err(_) => Err(deadline_not_committed(
                    "pg_read_tx_deadline",
                    "PostgreSQL read statement exceeded deadline",
                )),
            }
        };

        match run_res {
            Ok(val) => {
                if *can_cache_fast_conn {
                    let mut slot = fast_read_conn.lock().expect("pg fast_read_conn mutex");
                    if slot.is_none() {
                        *slot = Some(pooled);
                    }
                }
                if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
                    return Err(cancelled_not_committed(
                        "pg_read_cancelled",
                        "PostgreSQL read cancelled",
                    ));
                }
                Ok(val)
            }
            Err(err) => {
                let raw_conn = pooled.detach();
                tokio::spawn(async move {
                    let _ = raw_conn.close().await;
                });
                if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
                    return Err(cancelled_not_committed(
                        "pg_read_cancelled",
                        "PostgreSQL read cancelled",
                    ));
                }
                Err(err)
            }
        }
    }

    pub(crate) async fn with_read_tx<F, T>(&self, op: F) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        self.with_read_tx_budget(None, op).await
    }

    pub(crate) async fn with_read_tx_budget<F, T>(
        &self,
        budget: Option<&CallBudget>,
        op: F,
    ) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        self.with_read_tx_budget_pg_local_sql(budget, None, op)
            .await
    }

    pub(crate) async fn with_read_tx_budget_pg_local_sql<F, T>(
        &self,
        budget: Option<&CallBudget>,
        extra_pg_sql: Option<&'static str>,
        op: F,
    ) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        self.ensure_open()?;
        match &self.inner.sql {
            SqlDriverState::Sqlite { read_pool, .. } => {
                let wal = self.inner.wal_coord.get().ok_or_else(|| {
                    internal_not_committed(
                        "sqlite_wal_coord_missing",
                        "SqliteWalCoordinator not initialized",
                    )
                })?;
                wal.with_ordinary_read_tx(read_pool, budget, op).await
            }
            SqlDriverState::Postgres {
                pool,
                statement_timeout,
                ..
            } => {
                if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
                    return Err(cancelled_not_committed(
                        "pg_read_cancelled_pre_acquire",
                        "PostgreSQL read cancelled before pool acquire",
                    ));
                }
                let caller_rem = budget.map(|b| b.remaining).unwrap_or(*statement_timeout);
                if caller_rem.is_zero() {
                    return Err(deadline_not_committed(
                        "pg_read_zero_budget",
                        "PostgreSQL read call budget expired",
                    ));
                }
                let eff_timeout = caller_rem.min(*statement_timeout);
                let deadline_tokio = tokio::time::Instant::now() + eff_timeout;

                let mut pooled = tokio::select! {
                    res = pool.acquire() => res.map_err(|err| {
                        unavailable_retryable(
                            "pg_acquire_read",
                            err.to_string(),
                            Duration::from_millis(50),
                        )
                    })?,
                    _ = tokio::time::sleep_until(deadline_tokio) => {
                        return Err(deadline_not_committed(
                            "pg_acquire_read_deadline",
                            "deadline exceeded acquiring PostgreSQL read connection",
                        ));
                    }
                };

                let rem_ms = deadline_tokio
                    .saturating_duration_since(tokio::time::Instant::now())
                    .as_millis()
                    .max(1);
                let timeout_ms = u64::try_from(rem_ms).unwrap_or(200);

                let run_res: Result<T, PortError> = {
                    let conn: &mut sqlx::PgConnection = &mut pooled;
                    let mut backend = BackendConn::Postgres(conn);
                    let fut = async {
                        backend
                            .begin_read_with_pg_local_sql(Some(timeout_ms), extra_pg_sql)
                            .await?;
                        let val = op(&mut backend).await?;
                        backend.commit_read().await?;
                        Ok(val)
                    };
                    tokio::select! {
                        res = fut => res,
                        _ = tokio::time::sleep_until(deadline_tokio) => {
                            Err(deadline_not_committed(
                                "pg_read_tx_deadline",
                                "PostgreSQL read transaction exceeded deadline",
                            ))
                        }
                    }
                };

                match run_res {
                    Ok(val) => Ok(val),
                    Err(err) => {
                        // Detach timed-out or failed connection if needed so clean pool invariants hold.
                        let mut raw_conn = pooled.detach();
                        tokio::spawn(async move {
                            let _ = sqlx::raw_sql("ROLLBACK").execute(&mut raw_conn).await;
                            let _ = raw_conn.close().await;
                        });
                        if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
                            return Err(cancelled_not_committed(
                                "pg_read_cancelled",
                                "PostgreSQL read cancelled",
                            ));
                        }
                        Err(err)
                    }
                }
            }
        }
    }

    /// Initializes a canonical Space row and its permanent root folder atomically.
    pub async fn create_space(&self, spec: CreateSpaceSpec) -> Result<SpaceRecord, PortError> {
        let slug_fold = normalize_slug_key(&spec.slug)?;
        let created_at = match spec.created_at {
            Some(ts) => ts,
            None => now_utc_timestamp()?,
        };
        let (sec, nsec) = encode_timestamp_parts(created_at);
        let root_rev_id = new_revision_id()?;
        let root_meta =
            RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(FolderRevisionMetadata {
                folder_id: spec.root_folder_id.clone(),
                parent_folder_id: None,
                is_root: true,
                slug: "root".to_owned(),
                slug_fold: "root".to_owned(),
                display_name: "/".to_owned(),
                is_project: false,
                project_slug: None,
                description: None,
                cover_note_id: None,
                write_locked: false,
                lifecycle: Lifecycle::Active,
            }))
            .encode()?;

        let kind_str = match spec.kind {
            SpaceKind::Personal => "personal",
            SpaceKind::Shared => "shared",
        };
        let active_epoch_i64 = spec.active_epoch.get() as i64;
        let last_seq_i64 = spec.initial_last_seq.get() as i64;

        self.with_write_tx(|tx| {
            let spec_cl = spec.clone();
            let slug_fold_cl = slug_fold.clone();
            let root_rev_cl = root_rev_id.clone();
            let root_meta_cl = root_meta.clone();
            Box::pin(async move {
                let existing = fetch_space_by_id_or_slug(tx, &spec_cl.space_id, &slug_fold_cl).await?;
                if existing {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: spec_cl.space_id.clone(),
                            parent: None,
                            component: spec_cl.slug.clone(),
                        },
                    }
                    .into());
                }

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO spaces (
                                space_id, history_incarnation, root_folder_id, slug, slug_fold,
                                space_kind, owner_id, lifecycle_state, active_epoch, last_seq,
                                settings_json, created_at_sec, created_at_nsec
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, '{}', ?, ?)",
                        )
                        .bind(spec_cl.space_id.as_str())
                        .bind(spec_cl.incarnation.as_bytes().as_slice())
                        .bind(spec_cl.root_folder_id.as_str())
                        .bind(&spec_cl.slug)
                        .bind(&slug_fold_cl)
                        .bind(kind_str)
                        .bind(spec_cl.owner.as_str())
                        .bind(active_epoch_i64)
                        .bind(last_seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_insert_space", err.to_string()))?;

                        sqlx::query(
                            "INSERT INTO folder_heads (
                                space_id, folder_id, parent_folder_id, is_root, slug, slug_fold,
                                display_name, is_project, project_slug, project_slug_fold,
                                description, cover_note_id, write_lock_json, lifecycle_state,
                                rev_seq, head_rev_id, created_seq, updated_seq,
                                updated_at_sec, updated_at_nsec
                            ) VALUES (?, ?, NULL, 1, 'root', 'root', '/', 0, NULL, NULL, NULL, NULL, NULL, 'active', 0, ?, 0, 0, ?, ?)",
                        )
                        .bind(spec_cl.space_id.as_str())
                        .bind(spec_cl.root_folder_id.as_str())
                        .bind(root_rev_cl.as_str())
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_insert_root_folder", err.to_string()))?;

                        sqlx::query(
                            "INSERT INTO revisions (
                                space_id, history_incarnation, rev_id, entity_type, entity_key,
                                space_seq, visibility_seq, parent_rev_id, their_rev_id,
                                restored_from_rev_id, content_blake3, metadata_msgpack,
                                patch_meta_json, actor_id, session_id, agent_run_id,
                                quarantine_reason, created_at_sec, created_at_nsec
                            ) VALUES (?, ?, ?, 'folder', ?, 0, 0, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL, NULL, NULL, ?, ?)",
                        )
                        .bind(spec_cl.space_id.as_str())
                        .bind(spec_cl.incarnation.as_bytes().as_slice())
                        .bind(root_rev_cl.as_str())
                        .bind(spec_cl.root_folder_id.as_str())
                        .bind(&root_meta_cl)
                        .bind(spec_cl.owner.as_str())
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_insert_root_rev", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO spaces (
                                space_id, history_incarnation, root_folder_id, slug, slug_fold,
                                space_kind, owner_id, lifecycle_state, active_epoch, last_seq,
                                settings_json, created_at_sec, created_at_nsec
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, '{}', $10, $11)",
                        )
                        .bind(spec_cl.space_id.as_str())
                        .bind(spec_cl.incarnation.as_bytes().as_slice())
                        .bind(spec_cl.root_folder_id.as_str())
                        .bind(&spec_cl.slug)
                        .bind(&slug_fold_cl)
                        .bind(kind_str)
                        .bind(spec_cl.owner.as_str())
                        .bind(active_epoch_i64)
                        .bind(last_seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_insert_space", err.to_string()))?;

                        sqlx::query(
                            "INSERT INTO folder_heads (
                                space_id, folder_id, parent_folder_id, is_root, slug, slug_fold,
                                display_name, is_project, project_slug, project_slug_fold,
                                description, cover_note_id, write_lock_json, lifecycle_state,
                                rev_seq, head_rev_id, created_seq, updated_seq,
                                updated_at_sec, updated_at_nsec
                            ) VALUES ($1, $2, NULL, 1, 'root', 'root', '/', 0, NULL, NULL, NULL, NULL, NULL, 'active', 0, $3, 0, 0, $4, $5)",
                        )
                        .bind(spec_cl.space_id.as_str())
                        .bind(spec_cl.root_folder_id.as_str())
                        .bind(root_rev_cl.as_str())
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_insert_root_folder", err.to_string()))?;

                        sqlx::query(
                            "INSERT INTO revisions (
                                space_id, history_incarnation, rev_id, entity_type, entity_key,
                                space_seq, visibility_seq, parent_rev_id, their_rev_id,
                                restored_from_rev_id, content_blake3, metadata_msgpack,
                                patch_meta_json, actor_id, session_id, agent_run_id,
                                quarantine_reason, created_at_sec, created_at_nsec
                            ) VALUES ($1, $2, $3, 'folder', $4, 0, 0, NULL, NULL, NULL, NULL, $5, NULL, $6, NULL, NULL, NULL, $7, $8)",
                        )
                        .bind(spec_cl.space_id.as_str())
                        .bind(spec_cl.incarnation.as_bytes().as_slice())
                        .bind(root_rev_cl.as_str())
                        .bind(spec_cl.root_folder_id.as_str())
                        .bind(&root_meta_cl)
                        .bind(spec_cl.owner.as_str())
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_insert_root_rev", err.to_string()))?;
                    }
                }

                Ok(())
            })
        })
        .await?;

        Ok(SpaceRecord {
            space: Space {
                id: spec.space_id.clone(),
                lifecycle: SpaceLifecycle::Active,
                kind: spec.kind,
            },
            scope: HistoryScope {
                space_id: spec.space_id,
                incarnation: spec.incarnation,
            },
            root_folder_id: spec.root_folder_id,
            slug: spec.slug,
            owner: spec.owner,
            active_epoch: spec.active_epoch,
            last_seq: spec.initial_last_seq,
            created_at,
        })
    }

    pub async fn get_space(&self, space_id: &SpaceId) -> Result<SpaceRecord, PortError> {
        let id = space_id.clone();
        self.with_read_tx(|tx| {
            let id_cl = id.clone();
            Box::pin(async move { load_space_record(tx, &id_cl).await })
        })
        .await
    }

    /// Trusted lease turnover primitive updating `spaces.active_epoch`.
    pub async fn advance_space_lease(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        new_epoch: LeaseEpoch,
    ) -> Result<LeaseEpoch, PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        let scope_cl = scope.clone();
        self.with_write_tx(|tx| {
            let scope_inner = scope_cl.clone();
            Box::pin(async move {
                let current = load_space_record(tx, &scope_inner.space_id).await?;
                current.scope.check(&scope_inner)?;
                if new_epoch <= current.active_epoch {
                    return Err(
                        DomainError::validation(ValidationReason::InvalidState).into()
                    );
                }
                let epoch_i64 = new_epoch.get() as i64;
                let affected = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query(
                        "UPDATE spaces SET active_epoch = ? WHERE space_id = ? AND history_incarnation = ?",
                    )
                    .bind(epoch_i64)
                    .bind(scope_inner.space_id.as_str())
                    .bind(scope_inner.incarnation.as_bytes().as_slice())
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_advance_epoch", err.to_string()))?
                    .rows_affected(),
                    BackendConn::Postgres(conn) => sqlx::query(
                        "UPDATE spaces SET active_epoch = $1 WHERE space_id = $2 AND history_incarnation = $3",
                    )
                    .bind(epoch_i64)
                    .bind(scope_inner.space_id.as_str())
                    .bind(scope_inner.incarnation.as_bytes().as_slice())
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_advance_epoch", err.to_string()))?
                    .rows_affected(),
                };
                if affected != 1 {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Ok(new_epoch)
            })
        })
        .await
    }

    /// Creates a canonical folder inside `spec.scope` (normalizing `parent = None` to `root_folder_id`).
    pub async fn create_folder(
        &self,
        spec: CreateFolderSpec,
    ) -> Result<(FolderRef, RevisionId, SpaceSeq), PortError> {
        let slug_fold = normalize_slug_key(&spec.slug)?;
        let project_slug_fold = match (&spec.is_project, &spec.project_slug) {
            (false, None) => None,
            (true, Some(ps)) => Some(normalize_slug_key(ps)?),
            _ => return Err(DomainError::validation(ValidationReason::InvalidState).into()),
        };
        let ts = match spec.timestamp {
            Some(ts) => ts,
            None => now_utc_timestamp()?,
        };
        let (sec, nsec) = encode_timestamp_parts(ts);
        let now_ms = now_unix_ms()?;
        let rev_id = new_revision_id()?;
        let cmd_id = new_prefixed_hex_id("cmd_")?;

        let out = self
            .with_write_tx(|tx| {
                let spec_cl = spec.clone();
                let slug_fold_cl = slug_fold.clone();
                let proj_fold_cl = project_slug_fold.clone();
                let rev_cl = rev_id.clone();
                let cmd_cl = cmd_id.clone();
                Box::pin(async move {
                let space_rec = load_space_record(tx, &spec_cl.scope.space_id).await?;
                space_rec.scope.check(&spec_cl.scope)?;
                if space_rec.active_epoch != spec_cl.active_epoch {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }

                // Checked sequence bump BEFORE any effect!
                let next_seq = space_rec.last_seq.checked_next()?;
                let next_seq_i64 = next_seq.get() as i64;

                let parent_id = spec_cl
                    .parent
                    .clone()
                    .unwrap_or_else(|| space_rec.root_folder_id.clone());

                if parent_id == spec_cl.folder_id {
                    return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
                }
                if spec_cl.is_project && parent_id != space_rec.root_folder_id {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }

                // Verify parent exists in THIS Space, is Active, and stays within MAX_FOLDER_DEPTH (256).
                ensure_active_folder_in_space(tx, &spec_cl.scope.space_id, &parent_id).await?;
                let parent_anc = crate::domain::common::load_folder_ancestry_tx(
                    tx,
                    &spec_cl.scope.space_id,
                    &parent_id,
                    true,
                )
                .await?;
                let parent_depth = parent_anc.ancestors.len().saturating_sub(1);
                if parent_depth + 1 > crate::domain::common::MAX_FOLDER_DEPTH {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }

                // Check folder_id uniqueness and active sibling Unicode NFC+casefold collision.
                if folder_exists_in_space(tx, &spec_cl.scope.space_id, &spec_cl.folder_id).await?
                    || active_folder_sibling_exists(
                        tx,
                        &spec_cl.scope.space_id,
                        &parent_id,
                        &slug_fold_cl,
                    )
                    .await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: spec_cl.scope.space_id.clone(),
                            parent: Some(parent_id),
                            component: spec_cl.slug.clone(),
                        },
                    }
                    .into());
                }

                if let Some(pf) = &proj_fold_cl
                    && active_project_slug_exists(tx, &spec_cl.scope.space_id, pf).await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: spec_cl.scope.space_id.clone(),
                            parent: Some(parent_id),
                            component: spec_cl.project_slug.clone().unwrap_or_default(),
                        },
                    }
                    .into());
                }

                let meta_bytes = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(
                    FolderRevisionMetadata {
                        folder_id: spec_cl.folder_id.clone(),
                        parent_folder_id: Some(parent_id.clone()),
                        is_root: false,
                        slug: spec_cl.slug.clone(),
                        slug_fold: slug_fold_cl.clone(),
                        display_name: spec_cl.display_name.clone(),
                        is_project: spec_cl.is_project,
                        project_slug: spec_cl.project_slug.clone(),
                        description: None,
                        cover_note_id: None,
                        write_locked: false,
                        lifecycle: Lifecycle::Active,
                    },
                ))
                .encode()?;

                bump_space_seq_checked(
                    tx,
                    &spec_cl.scope,
                    spec_cl.active_epoch,
                    1,
                    space_rec.last_seq,
                )
                .await?;

                let is_proj_int: i32 = i32::from(spec_cl.is_project);
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO folder_heads (
                                space_id, folder_id, parent_folder_id, is_root, slug, slug_fold,
                                display_name, is_project, project_slug, project_slug_fold,
                                description, cover_note_id, write_lock_json, lifecycle_state,
                                rev_seq, head_rev_id, created_seq, updated_seq,
                                updated_at_sec, updated_at_nsec
                            ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(spec_cl.scope.space_id.as_str())
                        .bind(spec_cl.folder_id.as_str())
                        .bind(parent_id.as_str())
                        .bind(&spec_cl.slug)
                        .bind(&slug_fold_cl)
                        .bind(&spec_cl.display_name)
                        .bind(is_proj_int)
                        .bind(spec_cl.project_slug.as_deref())
                        .bind(proj_fold_cl.as_deref())
                        .bind(next_seq_i64)
                        .bind(rev_cl.as_str())
                        .bind(next_seq_i64)
                        .bind(next_seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_insert_folder", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO folder_heads (
                                space_id, folder_id, parent_folder_id, is_root, slug, slug_fold,
                                display_name, is_project, project_slug, project_slug_fold,
                                description, cover_note_id, write_lock_json, lifecycle_state,
                                rev_seq, head_rev_id, created_seq, updated_seq,
                                updated_at_sec, updated_at_nsec
                            ) VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, NULL, NULL, NULL, 'active', $10, $11, $10, $10, $12, $13)",
                        )
                        .bind(spec_cl.scope.space_id.as_str())
                        .bind(spec_cl.folder_id.as_str())
                        .bind(parent_id.as_str())
                        .bind(&spec_cl.slug)
                        .bind(&slug_fold_cl)
                        .bind(&spec_cl.display_name)
                        .bind(is_proj_int)
                        .bind(spec_cl.project_slug.as_deref())
                        .bind(proj_fold_cl.as_deref())
                        .bind(next_seq_i64)
                        .bind(rev_cl.as_str())
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_insert_folder", err.to_string()))?;
                    }
                }

                insert_revision_row(
                    tx,
                    &spec_cl.scope,
                    &rev_cl,
                    "folder",
                    spec_cl.folder_id.as_str(),
                    next_seq,
                    next_seq,
                    None,
                    None,
                    None,
                    &meta_bytes,
                    &spec_cl.actor,
                    None,
                    ts,
                )
                .await?;

                insert_command_and_event(
                    tx,
                    &spec_cl.scope,
                    &cmd_cl,
                    "create_folder",
                    next_seq,
                    "folder",
                    spec_cl.folder_id.as_str(),
                    "create",
                    &rev_cl,
                    Lifecycle::Active,
                    None,
                    None,
                    now_ms,
                )
                .await?;

                Ok((
                    FolderRef {
                        space_id: spec_cl.scope.space_id,
                        folder_id: spec_cl.folder_id,
                    },
                    rev_cl,
                    next_seq,
                ))
            })
        })
        .await?;

        self.inner
            .broadcast_hub
            .publish(BroadcastSignal::Committed {
                scope: spec.scope,
                new_last_seq: out.2,
            });
        Ok(out)
    }

    /// Sets a non-root folder's lifecycle (`Trash` or `Restore`), preserving active-sibling uniqueness.
    #[allow(clippy::too_many_arguments)]
    pub async fn set_folder_lifecycle(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        folder_id: &FolderId,
        expected_revision: &RevisionId,
        target_lifecycle: Lifecycle,
        actor: &PrincipalId,
        timestamp: Option<Timestamp>,
    ) -> Result<(RevisionId, SpaceSeq), PortError> {
        if target_lifecycle == Lifecycle::Purged {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let ts = match timestamp {
            Some(ts) => ts,
            None => now_utc_timestamp()?,
        };
        let (sec, nsec) = encode_timestamp_parts(ts);
        let now_ms = now_unix_ms()?;
        let new_rev = new_revision_id()?;
        let cmd_id = new_prefixed_hex_id("cmd_")?;
        let scope_cl = scope.clone();
        let folder_cl = folder_id.clone();
        let expected_cl = expected_revision.clone();
        let actor_cl = actor.clone();

        let broadcast_scope = scope.clone();
        let out = self
            .with_write_tx(|tx| {
                let new_rev_cl = new_rev.clone();
                let cmd_cl_in = cmd_id.clone();
                Box::pin(async move {
                let space_rec = load_space_record(tx, &scope_cl.space_id).await?;
                space_rec.scope.check(&scope_cl)?;
                if space_rec.active_epoch != active_epoch {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }
                if folder_cl == space_rec.root_folder_id {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                let next_seq = space_rec.last_seq.checked_next()?;
                let next_seq_i64 = next_seq.get() as i64;

                let folder_row = load_folder_head_row(tx, &scope_cl.space_id, &folder_cl).await?;
                if folder_row.is_root {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if folder_row.head_rev_id != expected_cl {
                    return Err(DomainError::RevisionConflict {
                        current: folder_row.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                let parent_id = folder_row.parent_folder_id.clone().ok_or_else(|| {
                    internal_not_committed("non_root_missing_parent", "non-root folder missing parent")
                })?;

                let op_kind = match (folder_row.lifecycle, target_lifecycle) {
                    (Lifecycle::Active, Lifecycle::Trashed) => "trash",
                    (Lifecycle::Trashed, Lifecycle::Active) => {
                        ensure_active_folder_in_space(tx, &scope_cl.space_id, &parent_id).await?;
                        if active_folder_sibling_exists(
                            tx,
                            &scope_cl.space_id,
                            &parent_id,
                            &folder_row.slug_fold,
                        )
                        .await?
                        {
                            return Err(DomainError::PathConflict {
                                target: PathTarget {
                                    space_id: scope_cl.space_id.clone(),
                                    parent: Some(parent_id),
                                    component: folder_row.slug,
                                },
                            }
                            .into());
                        }
                        if let Some(proj_fold) = &folder_row.project_slug_fold
                            && active_project_slug_exists(tx, &scope_cl.space_id, proj_fold).await?
                        {
                            return Err(DomainError::PathConflict {
                                target: PathTarget {
                                    space_id: scope_cl.space_id.clone(),
                                    parent: Some(parent_id),
                                    component: folder_row.project_slug.unwrap_or_default(),
                                },
                            }
                            .into());
                        }
                        "restore"
                    }
                    _ => return Err(DomainError::validation(ValidationReason::InvalidState).into()),
                };

                bump_space_seq_checked(
                    tx,
                    &scope_cl,
                    active_epoch,
                    1,
                    space_rec.last_seq,
                )
                .await?;

                let lc_str = lifecycle_to_db(target_lifecycle);
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET lifecycle_state = ?, rev_seq = ?, head_rev_id = ?, updated_seq = ?,
                                 updated_at_sec = ?, updated_at_nsec = ?
                             WHERE space_id = ? AND folder_id = ?",
                        )
                        .bind(lc_str)
                        .bind(next_seq_i64)
                        .bind(new_rev_cl.as_str())
                        .bind(next_seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope_cl.space_id.as_str())
                        .bind(folder_cl.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_update_folder_lc", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE folder_heads
                             SET lifecycle_state = $1, rev_seq = $2, head_rev_id = $3, updated_seq = $2,
                                 updated_at_sec = $4, updated_at_nsec = $5
                             WHERE space_id = $6 AND folder_id = $7",
                        )
                        .bind(lc_str)
                        .bind(next_seq_i64)
                        .bind(new_rev_cl.as_str())
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope_cl.space_id.as_str())
                        .bind(folder_cl.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_update_folder_lc", err.to_string()))?;
                    }
                }

                let meta_bytes = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Folder(
                    FolderRevisionMetadata {
                        folder_id: folder_cl.clone(),
                        parent_folder_id: Some(parent_id),
                        is_root: false,
                        slug: folder_row.slug,
                        slug_fold: folder_row.slug_fold,
                        display_name: folder_row.display_name,
                        is_project: folder_row.is_project,
                        project_slug: folder_row.project_slug,
                        description: folder_row.description,
                        cover_note_id: folder_row.cover_note_id,
                        write_locked: folder_row.write_locked,
                        lifecycle: target_lifecycle,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev_cl,
                    "folder",
                    folder_cl.as_str(),
                    next_seq,
                    next_seq,
                    Some(&folder_row.head_rev_id),
                    None,
                    None,
                    &meta_bytes,
                    &actor_cl,
                    None,
                    ts,
                )
                .await?;

                insert_command_and_event(
                    tx,
                    &scope_cl,
                    &cmd_cl_in,
                    "set_folder_lifecycle",
                    next_seq,
                    "folder",
                    folder_cl.as_str(),
                    op_kind,
                    &new_rev_cl,
                    target_lifecycle,
                    None,
                    None,
                    now_ms,
                )
                .await?;

                Ok((new_rev_cl, next_seq))
            })
        })
        .await?;

        self.inner
            .broadcast_hub
            .publish(BroadcastSignal::Committed {
                scope: broadcast_scope,
                new_last_seq: out.1,
            });
        Ok(out)
    }

    /// Reads an entity's immutable revision snapshot at a validated command-end cutoff (`visibility_seq <= cutoff`).
    pub async fn read_entity_revision_at_cutoff(
        &self,
        scope: &HistoryScope,
        entity_type: &str,
        entity_key: &str,
        cutoff: Option<SpaceSeq>,
    ) -> Result<Option<StoredRevisionRecord>, PortError> {
        let scope_cl = scope.clone();
        let et_cl = entity_type.to_owned();
        let ek_cl = entity_key.to_owned();
        self.with_read_tx(|tx| {
            Box::pin(async move {
                let valid_cutoff = validate_snapshot_cutoff_tx(tx, &scope_cl, cutoff).await?;
                read_immutable_revision_tx(tx, &scope_cl, &et_cl, &ek_cl, valid_cutoff).await
            })
        })
        .await
    }

    /// Returns the SQL query plan for the immutable `visibility_seq <= cutoff` query to certify index selection.
    pub async fn explain_immutable_revision_query_plan(
        &self,
        space_id: &SpaceId,
        entity_type: &str,
        entity_key: &str,
        cutoff: SpaceSeq,
    ) -> Result<String, PortError> {
        let sid = space_id.clone();
        let et = entity_type.to_owned();
        let ek = entity_key.to_owned();
        let cut_i64 = cutoff.get() as i64;

        self.with_read_tx(|tx| {
            Box::pin(async move {
                match tx {
                    BackendConn::Sqlite(conn) => {
                        let rows = sqlx::query(
                            "EXPLAIN QUERY PLAN
                             SELECT rev_id, space_seq, visibility_seq, content_blake3, metadata_msgpack,
                                    actor_id, agent_run_id, restored_from_rev_id, created_at_sec, created_at_nsec
                             FROM revisions
                             WHERE space_id = ? AND entity_type = ? AND entity_key = ? AND visibility_seq <= ?
                             ORDER BY visibility_seq DESC, space_seq DESC
                             LIMIT 1",
                        )
                        .bind(sid.as_str())
                        .bind(&et)
                        .bind(&ek)
                        .bind(cut_i64)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_explain_plan", err.to_string()))?;

                        let mut lines = Vec::with_capacity(rows.len());
                        for row in rows {
                            let detail: String = row.get("detail");
                            lines.push(detail);
                        }
                        Ok(lines.join("\n"))
                    }
                    BackendConn::Postgres(conn) => {
                        // Disable seqscan on tiny empty/few-row test tables so PG shows its chosen index path.
                        sqlx::query("SET LOCAL enable_seqscan = off")
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_disable_seqscan", err.to_string()))?;

                        let rows: Vec<String> = sqlx::query_scalar(
                            "EXPLAIN (COSTS OFF)
                             SELECT rev_id, space_seq, visibility_seq, content_blake3, metadata_msgpack,
                                    actor_id, agent_run_id, restored_from_rev_id, created_at_sec, created_at_nsec
                             FROM revisions
                             WHERE space_id = $1 AND entity_type = $2 AND entity_key = $3 AND visibility_seq <= $4
                             ORDER BY visibility_seq DESC, space_seq DESC
                             LIMIT 1",
                        )
                        .bind(sid.as_str())
                        .bind(&et)
                        .bind(&ek)
                        .bind(cut_i64)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_explain_plan", err.to_string()))?;

                        Ok(rows.join("\n"))
                    }
                }
            })
        })
        .await
    }
}

#[derive(Clone, Debug)]
pub(crate) struct FolderHeadRow {
    #[allow(dead_code)]
    pub folder_id: FolderId,
    pub parent_folder_id: Option<FolderId>,
    pub is_root: bool,
    pub slug: String,
    pub slug_fold: String,
    pub display_name: String,
    pub is_project: bool,
    pub project_slug: Option<String>,
    pub project_slug_fold: Option<String>,
    pub description: Option<String>,
    pub cover_note_id: Option<NoteId>,
    pub write_locked: bool,
    pub lifecycle: Lifecycle,
    pub head_rev_id: RevisionId,
}

async fn fetch_space_by_id_or_slug(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    slug_fold: &str,
) -> Result<bool, PortError> {
    let exists: Option<i64> =
        match tx {
            BackendConn::Sqlite(conn) => sqlx::query_scalar(
                "SELECT 1 FROM spaces WHERE space_id = ? OR slug_fold = ? LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(slug_fold)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_check_space_exists", err.to_string()))?,
            BackendConn::Postgres(conn) => sqlx::query_scalar(
                "SELECT 1::BIGINT FROM spaces WHERE space_id = $1 OR slug_fold = $2 LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(slug_fold)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_check_space_exists", err.to_string()))?,
        };
    Ok(exists.is_some())
}

pub(crate) async fn load_space_record(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<SpaceRecord, PortError> {
    let (
        inc_bytes,
        root_raw,
        slug,
        kind_raw,
        owner_raw,
        lc_raw,
        active_epoch_raw,
        last_seq_raw,
        sec,
        nsec,
    ): (
        Vec<u8>,
        String,
        String,
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i32,
    ) = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT history_incarnation, root_folder_id, slug, space_kind, owner_id,
                        lifecycle_state, active_epoch, last_seq, created_at_sec, created_at_nsec
                 FROM spaces WHERE space_id = ?",
            )
            .bind(space_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_space", err.to_string()))?
            .ok_or(DomainError::ResourceNotFound)?;
            (
                row.get("history_incarnation"),
                row.get("root_folder_id"),
                row.get("slug"),
                row.get("space_kind"),
                row.get("owner_id"),
                row.get("lifecycle_state"),
                row.get("active_epoch"),
                row.get("last_seq"),
                row.get("created_at_sec"),
                row.get::<i64, _>("created_at_nsec") as i32,
            )
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT history_incarnation, root_folder_id, slug, space_kind, owner_id,
                        lifecycle_state, active_epoch, last_seq, created_at_sec, created_at_nsec
                 FROM spaces WHERE space_id = $1",
            )
            .bind(space_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_space", err.to_string()))?
            .ok_or(DomainError::ResourceNotFound)?;
            (
                row.get("history_incarnation"),
                row.get("root_folder_id"),
                row.get("slug"),
                row.get("space_kind"),
                row.get("owner_id"),
                row.get("lifecycle_state"),
                row.get("active_epoch"),
                row.get("last_seq"),
                row.get("created_at_sec"),
                row.get("created_at_nsec"),
            )
        }
    };

    let inc_arr: [u8; 16] = inc_bytes
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_incarnation", "incarnation not 16 bytes"))?;
    let incarnation = HistoryIncarnation::from_bytes(inc_arr);
    let root_folder_id = FolderId::parse(&root_raw)
        .map_err(|_| internal_not_committed("corrupt_root_folder", "invalid root_folder_id"))?;
    let owner = PrincipalId::parse(&owner_raw)
        .map_err(|_| internal_not_committed("corrupt_owner_id", "invalid owner_id"))?;
    let kind = match kind_raw.as_str() {
        "personal" => SpaceKind::Personal,
        "shared" => SpaceKind::Shared,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_kind",
                format!("unexpected space_kind '{other}'"),
            ));
        }
    };
    let lifecycle = match lc_raw.as_str() {
        "active" => SpaceLifecycle::Active,
        "closing" => SpaceLifecycle::Closing,
        "archived" => SpaceLifecycle::Archived,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_lifecycle",
                format!("unexpected space lifecycle '{other}'"),
            ));
        }
    };
    let active_epoch = LeaseEpoch::new(
        u64::try_from(active_epoch_raw)
            .map_err(|_| internal_not_committed("corrupt_epoch", "negative active_epoch"))?,
    )?;
    let last_seq = i64_to_space_seq(last_seq_raw)?;
    let created_at = decode_timestamp_parts(sec, nsec)?;

    Ok(SpaceRecord {
        space: Space {
            id: space_id.clone(),
            lifecycle,
            kind,
        },
        scope: HistoryScope {
            space_id: space_id.clone(),
            incarnation,
        },
        root_folder_id,
        slug,
        owner,
        active_epoch,
        last_seq,
        created_at,
    })
}

pub(crate) async fn load_space_record_for_update_opt(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<Option<SpaceRecord>, PortError> {
    match tx {
        BackendConn::Sqlite(_) => match load_space_record(tx, space_id).await {
            Ok(rec) => Ok(Some(rec)),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(None),
            Err(other) => Err(other),
        },
        BackendConn::Postgres(conn) => {
            let row_opt = sqlx::query(
                "SELECT history_incarnation, root_folder_id, slug, space_kind, owner_id,
                        lifecycle_state, active_epoch, last_seq, created_at_sec, created_at_nsec
                 FROM spaces WHERE space_id = $1 FOR NO KEY UPDATE",
            )
            .bind(space_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_lock_and_load_space", err.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };
            let inc_bytes: Vec<u8> = row.get("history_incarnation");
            let root_raw: String = row.get("root_folder_id");
            let slug: String = row.get("slug");
            let kind_raw: String = row.get("space_kind");
            let owner_raw: String = row.get("owner_id");
            let lc_raw: String = row.get("lifecycle_state");
            let active_epoch_raw: i64 = row.get("active_epoch");
            let last_seq_raw: i64 = row.get("last_seq");
            let sec: i64 = row.get("created_at_sec");
            let nsec: i32 = row.get("created_at_nsec");

            let inc_arr: [u8; 16] = inc_bytes.try_into().map_err(|_| {
                internal_not_committed("corrupt_incarnation", "incarnation not 16 bytes")
            })?;
            let incarnation = HistoryIncarnation::from_bytes(inc_arr);
            let root_folder_id = FolderId::parse(&root_raw).map_err(|_| {
                internal_not_committed("corrupt_root_folder", "invalid root_folder_id")
            })?;
            let owner = PrincipalId::parse(&owner_raw)
                .map_err(|_| internal_not_committed("corrupt_owner_id", "invalid owner_id"))?;
            let kind = match kind_raw.as_str() {
                "personal" => SpaceKind::Personal,
                "shared" => SpaceKind::Shared,
                other => {
                    return Err(internal_not_committed(
                        "corrupt_space_kind",
                        format!("unexpected space_kind '{other}'"),
                    ));
                }
            };
            let lifecycle = match lc_raw.as_str() {
                "active" => SpaceLifecycle::Active,
                "closing" => SpaceLifecycle::Closing,
                "archived" => SpaceLifecycle::Archived,
                other => {
                    return Err(internal_not_committed(
                        "corrupt_space_lifecycle",
                        format!("unexpected space lifecycle '{other}'"),
                    ));
                }
            };
            let active_epoch =
                LeaseEpoch::new(u64::try_from(active_epoch_raw).map_err(|_| {
                    internal_not_committed("corrupt_epoch", "negative active_epoch")
                })?)?;
            let last_seq = i64_to_space_seq(last_seq_raw)?;
            let created_at = decode_timestamp_parts(sec, nsec)?;

            Ok(Some(SpaceRecord {
                space: Space {
                    id: space_id.clone(),
                    lifecycle,
                    kind,
                },
                scope: HistoryScope {
                    space_id: space_id.clone(),
                    incarnation,
                },
                root_folder_id,
                slug,
                owner,
                active_epoch,
                last_seq,
                created_at,
            }))
        }
    }
}

pub(crate) async fn bump_space_seq_checked(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    delta: u64,
    expected_before: SpaceSeq,
) -> Result<SpaceSeq, PortError> {
    if delta == 0 {
        return Ok(expected_before);
    }
    let next_u64 = expected_before
        .get()
        .checked_add(delta)
        .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;
    let new_last = SpaceSeq::new(next_u64)?;
    let delta_i64 = i64::try_from(delta)
        .map_err(|_| DomainError::validation(ValidationReason::SequenceOverflow))?;
    let epoch_i64 = active_epoch.get() as i64;
    let max_allowed_before = (SpaceSeq::MAX.get() - delta) as i64;

    match tx {
        BackendConn::Sqlite(conn) => {
            let affected = sqlx::query(
                "UPDATE spaces
                 SET last_seq = last_seq + ?
                 WHERE space_id = ? AND history_incarnation = ? AND active_epoch = ? AND last_seq <= ?",
            )
            .bind(delta_i64)
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(epoch_i64)
            .bind(max_allowed_before)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_bump_seq", err.to_string()))?
            .rows_affected();
            if affected != 1 {
                return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
            }
        }
        BackendConn::Postgres(conn) => {
            let affected = sqlx::query(
                "UPDATE spaces
                 SET last_seq = last_seq + $1
                 WHERE space_id = $2 AND history_incarnation = $3 AND active_epoch = $4 AND last_seq <= $5",
            )
            .bind(delta_i64)
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(epoch_i64)
            .bind(max_allowed_before)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_bump_seq", err.to_string()))?
            .rows_affected();
            if affected != 1 {
                return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
            }
        }
    }
    Ok(new_last)
}

pub(crate) async fn ensure_active_folder_in_space(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    folder_id: &FolderId,
) -> Result<(), PortError> {
    let lc: Option<String> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT lifecycle_state FROM folder_heads WHERE space_id = ? AND folder_id = ?",
        )
        .bind(space_id.as_str())
        .bind(folder_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_check_folder", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT lifecycle_state FROM folder_heads WHERE space_id = $1 AND folder_id = $2",
        )
        .bind(space_id.as_str())
        .bind(folder_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_check_folder", err.to_string()))?,
    };
    match lc.as_deref() {
        Some("active") => Ok(()),
        _ => Err(DomainError::ResourceNotFound.into()),
    }
}

pub(crate) async fn folder_exists_in_space(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    folder_id: &FolderId,
) -> Result<bool, PortError> {
    let exists: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar("SELECT 1 FROM folder_heads WHERE space_id = ? AND folder_id = ?")
                .bind(space_id.as_str())
                .bind(folder_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_folder_exists", err.to_string()))?
        }
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM folder_heads WHERE space_id = $1 AND folder_id = $2",
        )
        .bind(space_id.as_str())
        .bind(folder_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_folder_exists", err.to_string()))?,
    };
    Ok(exists.is_some())
}

pub(crate) async fn active_folder_sibling_exists(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    parent_folder_id: &FolderId,
    slug_fold: &str,
) -> Result<bool, PortError> {
    let exists: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM folder_heads
             WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ?
               AND lifecycle_state = 'active' AND is_root = 0
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(parent_folder_id.as_str())
        .bind(slug_fold)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_folder_sibling", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM folder_heads
             WHERE space_id = $1 AND parent_folder_id = $2 AND slug_fold = $3
               AND lifecycle_state = 'active' AND is_root = 0
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(parent_folder_id.as_str())
        .bind(slug_fold)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_folder_sibling", err.to_string()))?,
    };
    Ok(exists.is_some())
}

pub(crate) async fn active_project_slug_exists(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    project_slug_fold: &str,
) -> Result<bool, PortError> {
    let exists: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM folder_heads
             WHERE space_id = ? AND project_slug_fold = ?
               AND lifecycle_state = 'active' AND is_project = 1
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(project_slug_fold)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_proj_slug", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM folder_heads
             WHERE space_id = $1 AND project_slug_fold = $2
               AND lifecycle_state = 'active' AND is_project = 1
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(project_slug_fold)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_proj_slug", err.to_string()))?,
    };
    Ok(exists.is_some())
}

#[allow(clippy::type_complexity)]
pub(crate) async fn load_folder_head_row(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    folder_id: &FolderId,
) -> Result<FolderHeadRow, PortError> {
    let (
        parent_raw,
        is_root_raw,
        slug,
        slug_fold,
        display_name,
        is_proj_raw,
        project_slug,
        project_slug_fold,
        description,
        cover_raw,
        write_lock_json,
        lc_raw,
        head_rev_raw,
    ): (
        Option<String>,
        i32,
        String,
        String,
        String,
        i32,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT parent_folder_id, is_root, slug, slug_fold, display_name,
                        is_project, project_slug, project_slug_fold, description,
                        cover_note_id, write_lock_json, lifecycle_state, head_rev_id
                 FROM folder_heads WHERE space_id = ? AND folder_id = ?",
            )
            .bind(space_id.as_str())
            .bind(folder_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_folder", err.to_string()))?
            .ok_or(DomainError::ResourceNotFound)?;
            (
                row.get("parent_folder_id"),
                row.get::<i64, _>("is_root") as i32,
                row.get("slug"),
                row.get("slug_fold"),
                row.get("display_name"),
                row.get::<i64, _>("is_project") as i32,
                row.get("project_slug"),
                row.get("project_slug_fold"),
                row.get("description"),
                row.get("cover_note_id"),
                row.get("write_lock_json"),
                row.get("lifecycle_state"),
                row.get("head_rev_id"),
            )
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT parent_folder_id, is_root, slug, slug_fold, display_name,
                        is_project, project_slug, project_slug_fold, description,
                        cover_note_id, write_lock_json, lifecycle_state, head_rev_id
                 FROM folder_heads WHERE space_id = $1 AND folder_id = $2",
            )
            .bind(space_id.as_str())
            .bind(folder_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_folder", err.to_string()))?
            .ok_or(DomainError::ResourceNotFound)?;
            (
                row.get("parent_folder_id"),
                row.get("is_root"),
                row.get("slug"),
                row.get("slug_fold"),
                row.get("display_name"),
                row.get("is_project"),
                row.get("project_slug"),
                row.get("project_slug_fold"),
                row.get("description"),
                row.get("cover_note_id"),
                row.get("write_lock_json"),
                row.get("lifecycle_state"),
                row.get("head_rev_id"),
            )
        }
    };

    let parent_folder_id = match parent_raw {
        Some(s) => Some(FolderId::parse(&s).map_err(|_| {
            internal_not_committed("corrupt_parent_folder", "invalid parent_folder_id")
        })?),
        None => None,
    };
    let cover_note_id =
        match cover_raw {
            Some(s) => Some(NoteId::parse(&s).map_err(|_| {
                internal_not_committed("corrupt_cover_note", "invalid cover_note_id")
            })?),
            None => None,
        };
    let head_rev_id = RevisionId::parse(&head_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_folder_rev", "invalid head_rev_id"))?;
    let lifecycle = lifecycle_from_db(&lc_raw)?;

    Ok(FolderHeadRow {
        folder_id: folder_id.clone(),
        parent_folder_id,
        is_root: is_root_raw != 0,
        slug,
        slug_fold,
        display_name,
        is_project: is_proj_raw != 0,
        project_slug,
        project_slug_fold,
        description,
        cover_note_id,
        write_locked: write_lock_json.is_some(),
        lifecycle,
        head_rev_id,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_revision_row(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    rev_id: &RevisionId,
    entity_type: &str,
    entity_key: &str,
    space_seq: SpaceSeq,
    visibility_seq: SpaceSeq,
    parent_rev_id: Option<&RevisionId>,
    restored_from_rev_id: Option<&RevisionId>,
    content_blake3: Option<ContentDigest>,
    metadata_msgpack: &[u8],
    actor_id: &PrincipalId,
    agent_run_id: Option<&AgentRunId>,
    created_at: Timestamp,
) -> Result<(), PortError> {
    let (sec, nsec) = encode_timestamp_parts(created_at);
    let s_seq = space_seq.get() as i64;
    let v_seq = visibility_seq.get() as i64;
    let digest_slice = content_blake3.as_ref().map(|d| d.as_bytes().as_slice());

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO revisions (
                    space_id, history_incarnation, rev_id, entity_type, entity_key,
                    space_seq, visibility_seq, parent_rev_id, their_rev_id,
                    restored_from_rev_id, content_blake3, metadata_msgpack,
                    patch_meta_json, actor_id, session_id, agent_run_id,
                    quarantine_reason, created_at_sec, created_at_nsec
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(rev_id.as_str())
            .bind(entity_type)
            .bind(entity_key)
            .bind(s_seq)
            .bind(v_seq)
            .bind(parent_rev_id.map(RevisionId::as_str))
            .bind(restored_from_rev_id.map(RevisionId::as_str))
            .bind(digest_slice)
            .bind(metadata_msgpack)
            .bind(actor_id.as_str())
            .bind(agent_run_id.map(AgentRunId::as_str))
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_revision", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO revisions (
                    space_id, history_incarnation, rev_id, entity_type, entity_key,
                    space_seq, visibility_seq, parent_rev_id, their_rev_id,
                    restored_from_rev_id, content_blake3, metadata_msgpack,
                    patch_meta_json, actor_id, session_id, agent_run_id,
                    quarantine_reason, created_at_sec, created_at_nsec
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, NULL, $12, NULL, $13, NULL, $14, $15)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(rev_id.as_str())
            .bind(entity_type)
            .bind(entity_key)
            .bind(s_seq)
            .bind(v_seq)
            .bind(parent_rev_id.map(RevisionId::as_str))
            .bind(restored_from_rev_id.map(RevisionId::as_str))
            .bind(digest_slice)
            .bind(metadata_msgpack)
            .bind(actor_id.as_str())
            .bind(agent_run_id.map(AgentRunId::as_str))
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_revision", err.to_string()))?;
        }
    }
    Ok(())
}

pub(crate) struct RevisionInsertItem<'a> {
    pub rev_id: &'a RevisionId,
    pub entity_type: &'a str,
    pub entity_key: &'a str,
    pub space_seq: SpaceSeq,
    pub visibility_seq: SpaceSeq,
    pub parent_rev_id: Option<&'a RevisionId>,
    pub restored_from_rev_id: Option<&'a RevisionId>,
    pub content_blake3: Option<ContentDigest>,
    pub metadata_msgpack: &'a [u8],
    pub actor_id: &'a PrincipalId,
    pub agent_run_id: Option<&'a AgentRunId>,
    pub created_at: Timestamp,
}

pub(crate) async fn insert_revision_rows_batch_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    items: &[RevisionInsertItem<'_>],
) -> Result<(), PortError> {
    if items.is_empty() {
        return Ok(());
    }
    match tx {
        BackendConn::Sqlite(conn) => {
            for chunk in items.chunks(50) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "INSERT INTO revisions (
                        space_id, history_incarnation, rev_id, entity_type, entity_key,
                        space_seq, visibility_seq, parent_rev_id, their_rev_id,
                        restored_from_rev_id, content_blake3, metadata_msgpack,
                        patch_meta_json, actor_id, session_id, agent_run_id,
                        quarantine_reason, created_at_sec, created_at_nsec
                    ) ",
                );
                qb.push_values(chunk, |mut b, it| {
                    let (sec, nsec) = encode_timestamp_parts(it.created_at);
                    b.push_bind(scope.space_id.as_str())
                        .push_bind(scope.incarnation.as_bytes().as_slice())
                        .push_bind(it.rev_id.as_str())
                        .push_bind(it.entity_type)
                        .push_bind(it.entity_key)
                        .push_bind(it.space_seq.get() as i64)
                        .push_bind(it.visibility_seq.get() as i64)
                        .push_bind(it.parent_rev_id.map(RevisionId::as_str))
                        .push("NULL")
                        .push_bind(it.restored_from_rev_id.map(RevisionId::as_str))
                        .push_bind(it.content_blake3.as_ref().map(|d| d.as_bytes().as_slice()))
                        .push_bind(it.metadata_msgpack)
                        .push("NULL")
                        .push_bind(it.actor_id.as_str())
                        .push("NULL")
                        .push_bind(it.agent_run_id.map(AgentRunId::as_str))
                        .push("NULL")
                        .push_bind(sec)
                        .push_bind(nsec);
                });
                qb.build().execute(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_insert_revisions_batch", err.to_string())
                })?;
            }
        }
        BackendConn::Postgres(conn) => {
            let mut rev_ids: Vec<&str> = Vec::with_capacity(items.len());
            let mut entity_types: Vec<&str> = Vec::with_capacity(items.len());
            let mut entity_keys: Vec<&str> = Vec::with_capacity(items.len());
            let mut space_seqs: Vec<i64> = Vec::with_capacity(items.len());
            let mut vis_seqs: Vec<i64> = Vec::with_capacity(items.len());
            let mut parent_revs: Vec<Option<&str>> = Vec::with_capacity(items.len());
            let mut restored_revs: Vec<Option<&str>> = Vec::with_capacity(items.len());
            let mut digests: Vec<Option<&[u8]>> = Vec::with_capacity(items.len());
            let mut metas: Vec<&[u8]> = Vec::with_capacity(items.len());
            let mut actors: Vec<&str> = Vec::with_capacity(items.len());
            let mut runs: Vec<Option<&str>> = Vec::with_capacity(items.len());
            let mut secs: Vec<i64> = Vec::with_capacity(items.len());
            let mut nsecs: Vec<i32> = Vec::with_capacity(items.len());

            for it in items {
                let (sec, nsec) = encode_timestamp_parts(it.created_at);
                rev_ids.push(it.rev_id.as_str());
                entity_types.push(it.entity_type);
                entity_keys.push(it.entity_key);
                space_seqs.push(it.space_seq.get() as i64);
                vis_seqs.push(it.visibility_seq.get() as i64);
                parent_revs.push(it.parent_rev_id.map(RevisionId::as_str));
                restored_revs.push(it.restored_from_rev_id.map(RevisionId::as_str));
                digests.push(match &it.content_blake3 {
                    Some(d) => Some(d.as_bytes().as_slice()),
                    None => None,
                });
                metas.push(it.metadata_msgpack);
                actors.push(it.actor_id.as_str());
                runs.push(it.agent_run_id.map(AgentRunId::as_str));
                secs.push(sec);
                nsecs.push(nsec);
            }

            sqlx::query(
                "INSERT INTO revisions (
                    space_id, history_incarnation, rev_id, entity_type, entity_key,
                    space_seq, visibility_seq, parent_rev_id, their_rev_id,
                    restored_from_rev_id, content_blake3, metadata_msgpack,
                    patch_meta_json, actor_id, session_id, agent_run_id,
                    quarantine_reason, created_at_sec, created_at_nsec
                )
                SELECT
                    $1, $2, u.rev_id, u.entity_type, u.entity_key,
                    u.space_seq, u.vis_seq, u.parent_rev_id, NULL,
                    u.restored_rev_id, u.content_blake3, u.metadata_msgpack,
                    NULL, u.actor_id, NULL, u.agent_run_id,
                    NULL, u.sec, u.nsec
                FROM UNNEST(
                    $3::TEXT[], $4::TEXT[], $5::TEXT[], $6::BIGINT[], $7::BIGINT[],
                    $8::TEXT[], $9::TEXT[], $10::BYTEA[], $11::BYTEA[], $12::TEXT[],
                    $13::TEXT[], $14::BIGINT[], $15::INT4[]
                ) AS u(
                    rev_id, entity_type, entity_key, space_seq, vis_seq,
                    parent_rev_id, restored_rev_id, content_blake3, metadata_msgpack,
                    actor_id, agent_run_id, sec, nsec
                )",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(rev_ids)
            .bind(entity_types)
            .bind(entity_keys)
            .bind(space_seqs)
            .bind(vis_seqs)
            .bind(parent_revs)
            .bind(restored_revs)
            .bind(digests)
            .bind(metas)
            .bind(actors)
            .bind(runs)
            .bind(secs)
            .bind(nsecs)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_revisions_batch", err.to_string()))?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_command_and_event(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    command_id: &str,
    command_kind: &str,
    seq: SpaceSeq,
    entity_type: &str,
    entity_id: &str,
    op_kind: &str,
    rev_id: &RevisionId,
    lifecycle: Lifecycle,
    doc_class: Option<DocClass>,
    payload_id: Option<&str>,
    committed_at_ms: i64,
) -> Result<(), PortError> {
    let seq_i64 = seq.get() as i64;
    let lc_str = lifecycle_to_db(lifecycle);
    let class_str = doc_class.map(doc_class_to_db);

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO change_commands (
                    space_id, history_incarnation, command_id, first_seq, last_seq,
                    command_kind, payload_id, committed_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(command_id)
            .bind(seq_i64)
            .bind(seq_i64)
            .bind(command_kind)
            .bind(payload_id)
            .bind(committed_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_change_cmd", err.to_string()))?;

            sqlx::query(
                "INSERT INTO change_log (
                    space_id, space_seq, history_incarnation, command_id,
                    command_first_seq, command_last_seq, entity_type, entity_id,
                    op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(seq_i64)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(command_id)
            .bind(seq_i64)
            .bind(seq_i64)
            .bind(entity_type)
            .bind(entity_id)
            .bind(op_kind)
            .bind(rev_id.as_str())
            .bind(lc_str)
            .bind(class_str)
            .bind(payload_id)
            .bind(committed_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_change_log", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO change_commands (
                    space_id, history_incarnation, command_id, first_seq, last_seq,
                    command_kind, payload_id, committed_at_ms
                ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(command_id)
            .bind(seq_i64)
            .bind(command_kind)
            .bind(payload_id)
            .bind(committed_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_change_cmd", err.to_string()))?;

            sqlx::query(
                "INSERT INTO change_log (
                    space_id, space_seq, history_incarnation, command_id,
                    command_first_seq, command_last_seq, entity_type, entity_id,
                    op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                ) VALUES ($1, $2, $3, $4, $2, $2, $5, $6, $7, $8, $9, $10, $11, $12)",
            )
            .bind(scope.space_id.as_str())
            .bind(seq_i64)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(command_id)
            .bind(entity_type)
            .bind(entity_id)
            .bind(op_kind)
            .bind(rev_id.as_str())
            .bind(lc_str)
            .bind(class_str)
            .bind(payload_id)
            .bind(committed_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_change_log", err.to_string()))?;
        }
    }
    Ok(())
}

/// Validates that `cutoff` is either `None` (resolves to `spaces.last_seq`), `0`, or
/// an exact `change_commands.last_seq` in `scope`. Mid-command cutoffs return `InvalidCutoff`.
pub(crate) async fn validate_snapshot_cutoff_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: Option<SpaceSeq>,
) -> Result<SpaceSeq, PortError> {
    let space_rec = load_space_record(tx, &scope.space_id).await?;
    space_rec.scope.check(scope)?;

    let Some(requested) = cutoff else {
        return Ok(space_rec.last_seq);
    };
    if requested == SpaceSeq::ZERO {
        return Ok(SpaceSeq::ZERO);
    }
    if requested > space_rec.last_seq {
        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
    }
    require_command_end_tx(tx, scope, requested).await?;
    Ok(requested)
}

/// Zero is the initial boundary; every nonzero cursor must end a durable command.
pub(crate) async fn require_command_end_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    requested: SpaceSeq,
) -> Result<(), PortError> {
    if requested == SpaceSeq::ZERO {
        return Ok(());
    }
    let req_i64 = requested.get() as i64;
    let found_end: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM change_commands
             WHERE space_id = ? AND history_incarnation = ? AND last_seq = ?
             LIMIT 1",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(req_i64)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_check_cutoff", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM change_commands
             WHERE space_id = $1 AND history_incarnation = $2 AND last_seq = $3
             LIMIT 1",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(req_i64)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_check_cutoff", err.to_string()))?,
    };
    if found_end.is_none() {
        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
    }
    Ok(())
}

pub(crate) async fn is_note_purge_fenced_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &str,
) -> Result<bool, PortError> {
    let exists: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM revision_purge_fences WHERE space_id = ? AND note_id = ? LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(note_id)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_check_purge_fence", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM revision_purge_fences WHERE space_id = $1 AND note_id = $2 LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(note_id)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_check_purge_fence", err.to_string()))?,
    };
    Ok(exists.is_some())
}

pub(crate) async fn are_any_notes_purge_fenced_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_ids: &[NoteId],
) -> Result<bool, PortError> {
    if note_ids.is_empty() {
        return Ok(false);
    }
    if note_ids.len() == 1 {
        return is_note_purge_fenced_tx(tx, space_id, note_ids[0].as_str()).await;
    }
    for chunk in note_ids.chunks(200) {
        let found = match tx {
            BackendConn::Sqlite(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT 1 FROM revision_purge_fences WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str()).push(" AND note_id IN (");
                let mut sep = qb.separated(", ");
                for nid in chunk {
                    sep.push_bind(nid.as_str());
                }
                sep.push_unseparated(") LIMIT 1");
                let row: Option<i64> = qb
                    .build_query_scalar()
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_check_purge_fence_batch", err.to_string())
                    })?;
                row.is_some()
            }
            BackendConn::Postgres(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(
                    "SELECT 1::BIGINT FROM revision_purge_fences WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str()).push(" AND note_id IN (");
                let mut sep = qb.separated(", ");
                for nid in chunk {
                    sep.push_bind(nid.as_str());
                }
                sep.push_unseparated(") LIMIT 1");
                let row: Option<i64> = qb
                    .build_query_scalar()
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_check_purge_fence_batch", err.to_string())
                    })?;
                row.is_some()
            }
        };
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

#[allow(clippy::type_complexity)]
pub(crate) async fn read_immutable_revision_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    entity_type: &str,
    entity_key: &str,
    valid_cutoff: SpaceSeq,
) -> Result<Option<StoredRevisionRecord>, PortError> {
    if entity_type == "note" && is_note_purge_fenced_tx(tx, &scope.space_id, entity_key).await? {
        return Err(DomainError::ResourceNotFound.into());
    }

    let cut_i64 = valid_cutoff.get() as i64;
    let raw_row: Option<(
        String,
        i64,
        i64,
        Option<Vec<u8>>,
        Vec<u8>,
        String,
        Option<String>,
        Option<String>,
        i64,
        i32,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT rev_id, space_seq, visibility_seq, content_blake3, metadata_msgpack,
                        actor_id, agent_run_id, restored_from_rev_id, created_at_sec, created_at_nsec
                 FROM revisions
                 WHERE space_id = ? AND entity_type = ? AND entity_key = ? AND visibility_seq <= ?
                 ORDER BY visibility_seq DESC, space_seq DESC
                 LIMIT 1",
            )
            .bind(scope.space_id.as_str())
            .bind(entity_type)
            .bind(entity_key)
            .bind(cut_i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_read_immutable_rev", err.to_string()))?;

            row.map(|r| {
                (
                    r.get("rev_id"),
                    r.get("space_seq"),
                    r.get("visibility_seq"),
                    r.get("content_blake3"),
                    r.get("metadata_msgpack"),
                    r.get("actor_id"),
                    r.get("agent_run_id"),
                    r.get("restored_from_rev_id"),
                    r.get("created_at_sec"),
                    r.get::<i64, _>("created_at_nsec") as i32,
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT rev_id, space_seq, visibility_seq, content_blake3, metadata_msgpack,
                        actor_id, agent_run_id, restored_from_rev_id, created_at_sec, created_at_nsec
                 FROM revisions
                 WHERE space_id = $1 AND entity_type = $2 AND entity_key = $3 AND visibility_seq <= $4
                 ORDER BY visibility_seq DESC, space_seq DESC
                 LIMIT 1",
            )
            .bind(scope.space_id.as_str())
            .bind(entity_type)
            .bind(entity_key)
            .bind(cut_i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_read_immutable_rev", err.to_string()))?;

            row.map(|r| {
                (
                    r.get("rev_id"),
                    r.get("space_seq"),
                    r.get("visibility_seq"),
                    r.get("content_blake3"),
                    r.get("metadata_msgpack"),
                    r.get("actor_id"),
                    r.get("agent_run_id"),
                    r.get("restored_from_rev_id"),
                    r.get("created_at_sec"),
                    r.get("created_at_nsec"),
                )
            })
        }
    };

    let Some((
        rev_raw,
        s_seq_raw,
        v_seq_raw,
        digest_opt,
        meta_bytes,
        actor_raw,
        run_opt,
        restored_opt,
        sec,
        nsec,
    )) = raw_row
    else {
        return Ok(None);
    };

    let revision_id = RevisionId::parse(&rev_raw)
        .map_err(|_| internal_not_committed("corrupt_rev_id", "invalid rev_id"))?;
    let space_seq = i64_to_space_seq(s_seq_raw)?;
    let visibility_seq = i64_to_space_seq(v_seq_raw)?;
    let content_digest = match digest_opt {
        Some(bytes) => {
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| internal_not_committed("corrupt_rev_digest", "digest not 32 bytes"))?;
            Some(ContentDigest::from_bytes(arr))
        }
        None => None,
    };
    let metadata = RevisionMetadataEnvelope::decode(&meta_bytes)?;
    let actor_id = PrincipalId::parse(&actor_raw)
        .map_err(|_| internal_not_committed("corrupt_rev_actor", "invalid actor_id"))?;
    let agent_run_id = match run_opt {
        Some(s) => Some(
            AgentRunId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_rev_run", "invalid agent_run_id"))?,
        ),
        None => None,
    };
    let restored_from_rev_id = match restored_opt {
        Some(s) => Some(RevisionId::parse(&s).map_err(|_| {
            internal_not_committed("corrupt_restored_rev", "invalid restored_from_rev_id")
        })?),
        None => None,
    };
    let created_at = decode_timestamp_parts(sec, nsec)?;

    // Eliminate dead-code warnings on NoteRef/NoteRevisionMetadata imports until I2/I4 wire notes.
    let _ = std::marker::PhantomData::<(NoteRef, NoteRevisionMetadata, fn(&str) -> String)>;
    let _ = normalize_title_key;

    Ok(Some(StoredRevisionRecord {
        revision_id,
        space_seq,
        visibility_seq,
        content_digest,
        metadata,
        actor_id,
        agent_run_id,
        restored_from_rev_id,
        created_at,
    }))
}
