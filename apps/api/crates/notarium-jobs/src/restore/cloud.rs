use std::{
    io::{Read, Seek},
    path::PathBuf,
    sync::Arc,
};

use bytes::Bytes;
use http::Method;
use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, PgConnectConfig, S3Config, SqlBackendConfig, WriterConfig,
    backup::import_postgres_spool,
    blobs::{
        PreparedBlobPart, S3_MAX_RAW_CHUNK_BYTES,
        s3::{ReqwestS3Transport, S3BlobStore, S3RawRequest, S3Transport, namespace_fingerprint},
    },
    build_pg_connect_options, codec, manifest_checksum,
};
use notarium_control::{
    backup::{BackupConfig, ControlBackup, SpoolReader},
    keyring::{Keyring, KeyringLocation},
    store::{ControlStore, PostgresConfig, TargetRecord},
};
use notarium_core::{
    DomainError,
    epoch::{CLOUD_CANONICAL_SCHEMA, DataRoot},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, HistoryIncarnation, InstallationId},
    ports::{BackupParticipantPort, Cancellation, MaintenanceContext},
    receipt::ChangeCursor,
};
use sqlx::{Connection, PgConnection, Postgres, Transaction};
use tokio::sync::mpsc;

use super::{RestoreReport, same_cuts};
use crate::{
    BackupOptions,
    backup_format::{CasRecord, invalid, io_error},
    fsck::VerifiedArchive,
    import::check_cancelled,
};

/// A dedicated database and initially empty S3 prefix. Backups contain neither
/// the target credentials nor the installation's external key directory.
#[derive(Clone, Debug)]
pub struct CloudRestoreTarget {
    pub database: PgConnectConfig,
    pub object_store: S3Config,
    pub scratch: DataRoot,
    pub external_keyring: PathBuf,
}

struct Gate {
    archive: ContentDigest,
    installation: InstallationId,
    histories: Vec<ChangeCursor>,
    canonical_loaded: bool,
    ready: bool,
}

pub(super) async fn restore(
    ctx: MaintenanceContext,
    target: CloudRestoreTarget,
    archive: VerifiedArchive,
    options: BackupOptions,
) -> Result<RestoreReport, PortError> {
    check_cancelled(&ctx.budget.cancellation)?;
    let options_pg = build_pg_connect_options(&target.database);
    let mut database = PgConnection::connect_with(&options_pg)
        .await
        .map_err(pg_error)?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(608338971816154308)")
        .fetch_one(&mut database)
        .await
        .map_err(pg_error)?;
    if !acquired {
        return Err(DomainError::MigrationInProgress.into());
    }
    sqlx::raw_sql("SET synchronous_commit=on; SET statement_timeout='0'; SET idle_in_transaction_session_timeout='0';")
        .execute(&mut database).await.map_err(pg_error)?;
    let gate = open_gate(&mut database, &target.object_store, &archive).await?;
    if !gate.ready {
        let control = ControlStore::postgres_for_restore(
            PostgresConfig::from_connect_options(options_pg),
            &ctx.authority,
        )
        .await?;
        let recover = async {
            restore_control_rows(&mut database, &control, &ctx, &archive).await?;
            if !gate.canonical_loaded {
                let s3 = S3BlobStore::open(target.object_store.clone(), None).await?;
                restore_canonical_rows(&mut database, &gate, &s3, &ctx, &archive, options).await?;
            }
            rotate(&mut database, &control, &ctx, &target, &archive, &gate).await?;
            check_cancelled(&ctx.budget.cancellation)?;
            let changed = sqlx::query(
                "UPDATE notarium_restore.readiness SET phase='ready'
                 WHERE singleton=1 AND canonical_loaded AND phase='loading' AND archive_digest=$1",
            )
            .bind(gate.archive.as_bytes().as_slice())
            .execute(&mut database)
            .await
            .map_err(pg_error)?
            .rows_affected();
            if changed != 1 {
                return Err(invalid(ValidationReason::InvalidState));
            }
            Ok(())
        }
        .await;
        control.close().await;
        recover?;
    }
    verify_restored(&mut database, &gate).await?;
    Ok(RestoreReport {
        installation: gate.installation,
        archive_digest: gate.archive,
        histories: gate.histories,
    })
}

async fn open_gate(
    conn: &mut PgConnection,
    s3: &S3Config,
    archive: &VerifiedArchive,
) -> Result<Gate, PortError> {
    let digest = archive
        .report
        .archive_digest
        .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?;
    let installation = archive.report.installation.clone();
    let prefix = s3.application_prefix.trim_matches('/');
    if prefix.is_empty() || prefix.contains("..") || prefix.contains(['\\', '\0']) {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    let location = namespace_fingerprint(s3)?;
    let has_gate: bool =
        sqlx::query_scalar("SELECT to_regclass('notarium_restore.readiness') IS NOT NULL")
            .fetch_one(&mut *conn)
            .await
            .map_err(pg_error)?;
    if has_gate {
        type GateRow = (String, Vec<u8>, Vec<u8>, String, bool, String);
        let (install, saved, target, histories, canonical_loaded, phase): GateRow = sqlx::query_as(
             "SELECT installation_id,archive_digest,object_namespace,histories,canonical_loaded,phase
              FROM notarium_restore.readiness WHERE singleton=1",
        ).fetch_one(&mut *conn).await.map_err(pg_error)?;
        let histories: Vec<ChangeCursor> = serde_json::from_str(&histories)
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
        if install != installation.as_str()
            || saved != digest.as_bytes()
            || target != location.as_bytes()
            || !same_cuts(&histories, &archive.histories)
            || !matches!(phase.as_str(), "loading" | "ready")
        {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        return Ok(Gate {
            archive: digest,
            installation,
            histories,
            canonical_loaded,
            ready: phase == "ready",
        });
    }
    let empty: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_namespace
            WHERE nspname NOT IN ('public','information_schema','pg_catalog','pg_toast')
                AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%')
         AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public')",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(pg_error)?;
    if !empty {
        return Err(invalid(ValidationReason::InvalidState));
    }
    require_empty_prefix(s3, prefix).await?;
    let mut histories = archive.histories.clone();
    for cursor in &mut histories {
        cursor.scope.incarnation = HistoryIncarnation::from_bytes(codec::csprng_16()?);
    }
    let serialized =
        serde_json::to_string(&histories).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let mut tx = conn.begin().await.map_err(pg_error)?;
    sqlx::raw_sql(
        "CREATE SCHEMA notarium_restore;
         CREATE TABLE notarium_restore.readiness (
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           installation_id TEXT NOT NULL,
           archive_digest BYTEA NOT NULL CHECK(octet_length(archive_digest)=32),
           object_namespace BYTEA NOT NULL CHECK(octet_length(object_namespace)=32),
           histories TEXT NOT NULL,
           canonical_loaded BOOLEAN NOT NULL DEFAULT FALSE,
           phase TEXT NOT NULL CHECK(phase IN ('loading','ready'))
         );",
    )
    .execute(&mut *tx)
    .await
    .map_err(pg_error)?;
    sqlx::query(
        "INSERT INTO notarium_restore.readiness(singleton,installation_id,archive_digest,object_namespace,histories,phase)
         VALUES(1,$1,$2,$3,$4,'loading')",
    ).bind(installation.as_str()).bind(digest.as_bytes().as_slice())
        .bind(location.as_bytes().as_slice()).bind(serialized).execute(&mut *tx).await.map_err(pg_error)?;
    tx.commit().await.map_err(pg_error)?;
    Ok(Gate {
        archive: digest,
        installation,
        histories,
        canonical_loaded: false,
        ready: false,
    })
}

async fn require_empty_prefix(config: &S3Config, prefix: &str) -> Result<(), PortError> {
    let transport = ReqwestS3Transport::new(config)?;
    let response = transport
        .send_bounded(
            S3RawRequest {
                method: Method::GET,
                key: None,
                query: vec![
                    ("list-type".to_owned(), "2".to_owned()),
                    ("max-keys".to_owned(), "1".to_owned()),
                    ("prefix".to_owned(), format!("{prefix}/")),
                ],
                headers: Vec::new(),
                body: Bytes::new(),
            },
            64 * 1024,
        )
        .await?;
    let xml =
        std::str::from_utf8(&response.body).map_err(|_| invalid(ValidationReason::InvalidState))?;
    if response.status != 200
        || !xml.contains("<KeyCount>0</KeyCount>")
        || !xml.contains("<IsTruncated>false</IsTruncated>")
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let mode =
        notarium_canonical::blobs::s3::resolve_bucket_mode(&transport, config.bucket_mode_policy)
            .await?;
    if mode == notarium_canonical::S3BucketMode::Enabled {
        let versions = transport
            .send_bounded(
                S3RawRequest {
                    method: Method::GET,
                    key: None,
                    query: vec![
                        ("versions".to_owned(), String::new()),
                        ("max-keys".to_owned(), "1".to_owned()),
                        ("prefix".to_owned(), format!("{prefix}/")),
                    ],
                    headers: Vec::new(),
                    body: Bytes::new(),
                },
                64 * 1024,
            )
            .await?;
        let xml = std::str::from_utf8(&versions.body)
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
        if versions.status != 200
            || !xml.contains("<IsTruncated>false</IsTruncated>")
            || xml.contains("<Version>")
            || xml.contains("<DeleteMarker>")
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    Ok(())
}

async fn restore_control_rows(
    conn: &mut PgConnection,
    control: &ControlStore,
    ctx: &MaintenanceContext,
    archive: &VerifiedArchive,
) -> Result<(), PortError> {
    let persisted: Option<(String, String)> = sqlx::query_as(
        "SELECT installation_id,state FROM v1_control.v1_storage_epoch WHERE singleton=1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(pg_error)?;
    if let Some((id, state)) = persisted {
        if id != archive.report.installation.as_str()
            || !matches!(state.as_str(), "migrating" | "ready")
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
    } else {
        let mut decoder = SpoolReader::open(archive.control()?)?;
        let mut transaction = control.begin_target_import(ctx.clone()).await?;
        while let Some(mut record) = decoder.next_record()? {
            check_cancelled(&ctx.budget.cancellation)?;
            if let TargetRecord::V1StorageEpoch {
                state,
                receipt_json,
                receipt_sha256,
                ..
            } = &mut record
            {
                "migrating".clone_into(state);
                *receipt_json = None;
                *receipt_sha256 = None;
            }
            transaction.append(&[record]).await?;
        }
        transaction.finish().await?;
    }
    sqlx::query(
        "UPDATE v1_control.v1_storage_epoch SET state='ready' WHERE singleton=1
         AND installation_id=$1 AND state='migrating'",
    )
    .bind(archive.report.installation.as_str())
    .execute(&mut *conn)
    .await
    .map_err(pg_error)?;
    Ok(())
}

async fn restore_canonical_rows(
    conn: &mut PgConnection,
    gate: &Gate,
    store: &S3BlobStore,
    ctx: &MaintenanceContext,
    archive: &VerifiedArchive,
    options: BackupOptions,
) -> Result<(), PortError> {
    notarium_canonical::schema::bootstrap_postgres_schema(
        conn,
        CLOUD_CANONICAL_SCHEMA,
        &gate.installation,
    )
    .await?;
    let mut tx = conn.begin().await.map_err(pg_error)?;
    sqlx::raw_sql("SET LOCAL search_path TO v1_canonical,pg_catalog; DELETE FROM schema_meta")
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
    let witness = import_postgres_spool(
        archive.canonical()?,
        archive.manifest.canonical.bytes,
        options.max_pg_row_bytes,
        ctx.budget.cancellation.clone(),
        &mut tx,
    )
    .await?;
    if witness.installation != gate.installation || witness.histories != archive.histories {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    sqlx::query(
        "UPDATE schema_meta SET schema_version=$1, manifest_checksum=$2 WHERE singleton_id=1",
    )
    .bind(notarium_canonical::CANONICAL_SCHEMA_VERSION as i32)
    .bind(manifest_checksum().as_bytes().as_slice())
    .execute(&mut *tx)
    .await
    .map_err(pg_error)?;
    sqlx::raw_sql(
        "DELETE FROM blob_parts;
         DELETE FROM blob_publications;
         DELETE FROM blob_catalog WHERE ref_count=0;
         UPDATE content_jobs SET lease_owner=NULL, lease_until_ms=NULL,artifacts_json='[]',result_msgpack=NULL,
           state=CASE WHEN state IN ('queued','running') THEN 'failed' ELSE state END;",
    ).execute(&mut *tx).await.map_err(pg_error)?;
    let mut index = archive.index()?;
    for position in 0..index.count {
        check_cancelled(&ctx.budget.cancellation)?;
        let record = index.read(position)?;
        restore_publication(
            &mut tx,
            gate,
            store,
            archive,
            record,
            &ctx.budget.cancellation,
        )
        .await?;
    }
    let missing: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM blob_references r
          LEFT JOIN blob_publications p ON p.space_id=r.space_id AND p.publication_id=r.publication_id
          WHERE p.publication_id IS NULL OR p.content_blake3<>r.content_blake3)",
    ).fetch_one(&mut *tx).await.map_err(pg_error)?;
    if missing {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    sqlx::query("UPDATE notarium_restore.readiness SET canonical_loaded=true WHERE singleton=1")
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
    tx.commit().await.map_err(pg_error)
}

async fn restore_publication(
    tx: &mut Transaction<'_, Postgres>,
    gate: &Gate,
    store: &S3BlobStore,
    source: &VerifiedArchive,
    record: CasRecord,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    let mut identity = blake3::Hasher::new();
    identity.update(b"notarium-restored-publication-v1\0");
    identity.update(gate.archive.as_bytes());
    identity.update(record.space.as_str().as_bytes());
    identity.update(record.digest.as_bytes());
    let digest = identity.finalize();
    let publication = format!(
        "pub_{:032x}",
        u128::from_be_bytes(digest.as_bytes()[..16].try_into().unwrap())
    );
    let count = record.raw.div_ceil(S3_MAX_RAW_CHUNK_BYTES as u64).max(1);
    let part_count = i32::try_from(count).map_err(|_| invalid(ValidationReason::BudgetExceeded))?;
    let now = codec::now_unix_ms()?;
    sqlx::query(
        "INSERT INTO blob_publications(space_id,publication_id,content_blake3,owner_epoch,codec,state,
              manifest_sealed,part_count,raw_size,compressed_size,created_at_ms,updated_at_ms)
         SELECT space_id,$2,$3,active_epoch,'s3_chunked_v1','active',1,$4,$5,0,$6,$6 FROM spaces WHERE space_id=$1",
    ).bind(record.space.as_str()).bind(&publication).bind(record.digest.as_bytes().as_slice())
        .bind(part_count).bind(record.raw as i64).bind(now)
        .execute(&mut **tx).await.map_err(pg_error)?;
    let (parts, mut queue) = mpsc::channel(1);
    let task = tokio::task::spawn_blocking({
        let reader = source.blob(&record)?;
        let cancellation = cancellation.clone();
        let record = record.clone();
        move || prepare_parts(reader, &record, parts, cancellation)
    });
    let written = async {
        let mut compressed = 0_u64;
        while let Some(part) = queue.recv().await {
            check_cancelled(cancellation)?;
            let key = format!(
                "{}spaces/{}/cas-v1/{publication}/{}",
                store.application_prefix(),
                record.space,
                part.part_index
            );
            let observed = store.put_part_if_absent_or_reconcile(&key, &part).await?;
            if observed.is_some()
                != (store.bucket_mode() == notarium_canonical::S3BucketMode::Enabled)
            {
                return Err(invalid(ValidationReason::InvalidAuthority));
            }
            sqlx::query(
                "INSERT INTO blob_parts(space_id,publication_id,part_index,raw_size,compressed_size,
                     part_blake3,physical_key,observed_version_id,upload_confirmed)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)",
            ).bind(record.space.as_str()).bind(&publication).bind(part.part_index as i32)
                .bind(part.raw_size as i64).bind(part.compressed.len() as i64)
                .bind(part.part_blake3.as_bytes().as_slice()).bind(key).bind(observed)
                .execute(&mut **tx).await.map_err(pg_error)?;
            compressed += part.compressed.len() as u64;
        }
        Ok::<_, PortError>(compressed as i64)
    }
    .await;
    drop(queue);
    let generated = task.await.map_err(super::join_error)?;
    let compressed = written?;
    generated?;
    sqlx::query(
        "UPDATE blob_publications SET compressed_size=$1 WHERE space_id=$2 AND publication_id=$3",
    )
    .bind(compressed)
    .bind(record.space.as_str())
    .bind(&publication)
    .execute(&mut **tx)
    .await
    .map_err(pg_error)?;
    sqlx::query("UPDATE blob_catalog SET current_publication_id=$1,compressed_size=$2,quarantined_at_ms=NULL,legacy_cleanup=0
        WHERE space_id=$3 AND content_blake3=$4 AND ref_count>0")
        .bind(&publication).bind(compressed).bind(record.space.as_str()).bind(record.digest.as_bytes().as_slice())
        .execute(&mut **tx).await.map_err(pg_error)?;
    sqlx::query(
        "UPDATE blob_references SET publication_id=$1 WHERE space_id=$2 AND content_blake3=$3",
    )
    .bind(publication)
    .bind(record.space.as_str())
    .bind(record.digest.as_bytes().as_slice())
    .execute(&mut **tx)
    .await
    .map_err(pg_error)?;
    Ok(())
}

fn prepare_parts(
    reader: impl Read + Seek,
    record: &CasRecord,
    parts: mpsc::Sender<PreparedBlobPart>,
    cancellation: Cancellation,
) -> Result<(), PortError> {
    let mut input = zstd::stream::read::Decoder::new(reader)
        .map_err(io_error)?
        .single_frame();
    input.window_log_max(23).map_err(io_error)?;
    let mut buffer = vec![0; S3_MAX_RAW_CHUNK_BYTES];
    let mut remaining = record.raw;
    let mut hash = blake3::Hasher::new();
    let count = remaining.div_ceil(S3_MAX_RAW_CHUNK_BYTES as u64).max(1);
    for position in 0..count {
        check_cancelled(&cancellation)?;
        let size = remaining.min(buffer.len() as u64) as usize;
        let data = &mut buffer[..size];
        input.read_exact(data).map_err(io_error)?;
        remaining -= size as u64;
        hash.update(data);
        let encoded = zstd::stream::encode_all(&*data, 3).map_err(io_error)?;
        parts
            .blocking_send(PreparedBlobPart {
                part_index: position as u32,
                raw_size: size as u64,
                part_blake3: ContentDigest::from_bytes(*blake3::hash(data).as_bytes()),
                compressed: Arc::from(encoded),
            })
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
    }
    if input.read(&mut [0]).map_err(io_error)? != 0
        || input.finish().stream_position().map_err(io_error)? != record.compressed
        || hash.finalize().as_bytes() != record.digest.as_bytes()
    {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(())
}

async fn rotate(
    conn: &mut PgConnection,
    control: &ControlStore,
    ctx: &MaintenanceContext,
    target: &CloudRestoreTarget,
    archive: &VerifiedArchive,
    gate: &Gate,
) -> Result<(), PortError> {
    let config = CanonicalConfig {
        installation_id: gate.installation.clone(),
        sql: SqlBackendConfig::postgres_default(target.database.clone(), CLOUD_CANONICAL_SCHEMA),
        blobs: notarium_canonical::BlobBackendConfig::S3(Box::new(target.object_store.clone())),
        writer: WriterConfig::default(),
        snapshot_retention: std::time::Duration::from_secs(300),
        default_backup_budget: notarium_canonical::config::default_postgres_backup_budget(),
    };
    let (store, runtime) = CanonicalRuntime::open_for_restore(config, &ctx.authority).await?;
    let result = async {
        let current = read_histories(conn).await?;
        if current != gate.histories {
            if current != archive.histories {
                return Err(invalid(ValidationReason::HistoryIncarnationMismatch));
            }
            let rotated = store
                .restore_cursors(ctx.clone(), gate.histories.clone())
                .await;
            if rotated.is_err() && read_histories(conn).await? != gate.histories {
                rotated?;
            }
        }
        let keyring = Keyring::open(
            control.clone(),
            KeyringLocation::External(target.external_keyring.clone()),
            ctx.budget.clone(),
        )
        .await?;
        let backup = ControlBackup::new(
            control.clone(),
            keyring,
            target.scratch.clone(),
            BackupConfig::default(),
        )?;
        backup
            .restore_cursors(ctx.clone(), gate.histories.clone())
            .await?;
        Ok::<_, PortError>(())
    }
    .await;
    drop(store);
    let shutdown = runtime.shutdown().await;
    result?;
    shutdown?;
    verify_restored(conn, gate).await
}

async fn read_histories(conn: &mut PgConnection) -> Result<Vec<ChangeCursor>, PortError> {
    let rows: Vec<(String, Vec<u8>, i64)> = sqlx::query_as(
        "SELECT space_id,history_incarnation,last_seq FROM v1_canonical.spaces ORDER BY space_id COLLATE \"C\"",
    ).fetch_all(conn).await.map_err(pg_error)?;
    rows.into_iter()
        .map(|(space, history, last)| {
            Ok(ChangeCursor {
                scope: notarium_core::model::HistoryScope {
                    space_id: notarium_core::ids::SpaceId::parse(&space)?,
                    incarnation: HistoryIncarnation::from_bytes(
                        history
                            .try_into()
                            .map_err(|_| invalid(ValidationReason::InvalidState))?,
                    ),
                },
                after: notarium_core::ids::SpaceSeq::new(
                    u64::try_from(last).map_err(|_| invalid(ValidationReason::InvalidState))?,
                )?,
            })
        })
        .collect()
}

async fn verify_restored(conn: &mut PgConnection, gate: &Gate) -> Result<(), PortError> {
    if read_histories(conn).await? != gate.histories {
        return Err(invalid(ValidationReason::HistoryIncarnationMismatch));
    }
    let matching: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM v1_canonical.schema_meta c JOIN v1_control.v1_storage_epoch t
          ON t.installation_id=c.installation_id WHERE c.installation_id=$1 AND c.migration_state='ready' AND t.state='ready')",
    ).bind(gate.installation.as_str()).fetch_one(&mut *conn).await.map_err(pg_error)?;
    let bad_cursors: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM (
              SELECT space_id,history_incarnation,acked_space_seq FROM v1_control.mcp_delta_owner_cursors
              UNION ALL SELECT space_id,history_incarnation,acked_space_seq FROM v1_control.mcp_delta_session_cursors
           ) c LEFT JOIN v1_canonical.spaces s ON s.space_id=c.space_id
           WHERE s.space_id IS NULL OR s.history_incarnation<>c.history_incarnation OR c.acked_space_seq>s.last_seq)",
    ).fetch_one(&mut *conn).await.map_err(pg_error)?;
    if !matching || bad_cursors {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(())
}

fn pg_error(error: sqlx::Error) -> PortError {
    codec::internal_not_committed("cloud_restore_database", error.to_string())
}
