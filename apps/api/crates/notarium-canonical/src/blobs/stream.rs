use std::{
    io::{Cursor, Read},
    sync::Arc,
    time::Duration,
};

use bytes::Bytes;
use http::Method;
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{BackupId, ContentDigest},
    model::HistoryScope,
    ports::{CallBudget, Cancellation},
};
use tokio::sync::mpsc;

use crate::{
    CanonicalStore,
    codec::{cancelled_not_committed, internal_not_committed},
    config::S3BucketMode,
    sql_exec::BackendConn,
};

use super::{
    BlobBackendDriver, S3_MAX_RAW_CHUNK_BYTES, S3ManifestPart, TerminalMarkerMeta,
    load_s3_manifest_parts_tx, s3::S3RawRequest,
};

const COPY_BUFFER: usize = 64 * 1024;

impl CanonicalStore {
    /// Stream and verify the raw logical blob under a durable CAS hold. No
    /// SQL transaction remains open while the sink applies backpressure.
    pub async fn stream_held_blob(
        &self,
        budget: &CallBudget,
        hold: &BackupId,
        scope: &HistoryScope,
        digest: ContentDigest,
        output: &mpsc::Sender<Bytes>,
    ) -> Result<u64, PortError> {
        let owner = scope.clone();
        let hold = hold.clone();
        let (raw, compressed, parts) = self
            .with_read_tx_budget(Some(budget), |tx| {
                Box::pin(async move {
                    let (publication, raw, compressed, part_count) =
                        held_publication(tx, &hold, &owner, digest).await?;
                    let parts = if tx.is_postgres() {
                        if !(1..=65_536).contains(&part_count)
                            || part_count as u64
                                != raw.div_ceil(S3_MAX_RAW_CHUNK_BYTES as u64).max(1)
                        {
                            return Err(invalid_digest());
                        }
                        let parts = load_s3_manifest_parts_tx(
                            tx,
                            &owner.space_id,
                            &publication,
                            part_count,
                        )
                        .await?;
                        attach_versions(tx, &owner, &publication, parts).await?
                    } else {
                        Vec::new()
                    };
                    Ok((raw, compressed, parts))
                })
            })
            .await?;
        let cancellation = budget.cancellation.clone();
        match &self.inner.blobs {
            BlobBackendDriver::Local(store) => {
                let store = Arc::clone(store);
                let space = scope.space_id.clone();
                let output = output.clone();
                let guard = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(cancelled()),
                    acquired = store.acquire_shared_guard(&space, digest) => acquired,
                };
                self.inner
                    .backup_executor
                    .spawn_blocking(move || {
                        let _guard = guard;
                        let file = store.open_compressed(&space, digest)?;
                        if file.metadata().map_err(stream_io)?.len() != compressed {
                            return Err(invalid_digest());
                        }
                        let mut full = blake3::Hasher::new();
                        send_frame(file, raw, digest, &mut full, &output, &cancellation)?;
                        Ok(raw)
                    })
                    .await
                    .map_err(copy_join_error)?
            }
            BlobBackendDriver::S3(store) => {
                let mut full = blake3::Hasher::new();
                let mut sizes = (0_u64, 0_u64);
                for (part, version) in parts {
                    let bounds = zstd::zstd_safe::compress_bound(S3_MAX_RAW_CHUNK_BYTES) as u64;
                    if part.raw_size > S3_MAX_RAW_CHUNK_BYTES as u64
                        || part.compressed_size > bounds
                        || (store.bucket_mode() == S3BucketMode::Enabled && version.is_none())
                    {
                        return Err(invalid_digest());
                    }
                    if !part.physical_key.starts_with(store.application_prefix()) {
                        return Err(invalid_digest());
                    }
                    let request = S3RawRequest {
                        method: Method::GET,
                        key: Some(part.physical_key),
                        query: version
                            .as_ref()
                            .map(|id| ("versionId".to_owned(), id.clone()))
                            .into_iter()
                            .collect(),
                        headers: Vec::new(),
                        body: Bytes::new(),
                    };
                    let response = tokio::select! {
                        biased;
                        () = cancellation.cancelled() => return Err(cancelled()),
                        response = store.transport().send_bounded(request, part.compressed_size as usize) => response?,
                    };
                    if response.status != 200
                        || response.body.len() as u64 != part.compressed_size
                        || version
                            .as_deref()
                            .is_some_and(|id| response.version_id().as_deref() != Some(id))
                        || TerminalMarkerMeta::is_terminal_marker(&response.body)
                    {
                        return Err(invalid_digest());
                    }
                    sizes.0 = sizes
                        .0
                        .checked_add(part.raw_size)
                        .ok_or_else(invalid_digest)?;
                    sizes.1 = sizes
                        .1
                        .checked_add(part.compressed_size)
                        .ok_or_else(invalid_digest)?;
                    if sizes.0 > raw || sizes.1 > compressed {
                        return Err(invalid_digest());
                    }
                    full = self
                        .inner
                        .backup_executor
                        .spawn_blocking({
                            let output = output.clone();
                            let cancellation = cancellation.clone();
                            move || {
                                send_frame(
                                    Cursor::new(response.body),
                                    part.raw_size,
                                    part.part_blake3,
                                    &mut full,
                                    &output,
                                    &cancellation,
                                )?;
                                Ok::<_, PortError>(full)
                            }
                        })
                        .await
                        .map_err(copy_join_error)??;
                }
                if sizes != (raw, compressed) || full.finalize().as_bytes() != digest.as_bytes() {
                    return Err(invalid_digest());
                }
                Ok(raw)
            }
        }
    }
}

async fn held_publication(
    tx: &mut BackendConn<'_>,
    hold: &BackupId,
    scope: &HistoryScope,
    digest: ContentDigest,
) -> Result<(String, u64, u64, u32), PortError> {
    const SELECT: &str =
        "SELECT p.publication_id, p.raw_size,p.compressed_size, CAST(p.part_count AS BIGINT)
        FROM blob_catalog c JOIN blob_publications p
          ON p.space_id=c.space_id AND p.publication_id=c.current_publication_id
          AND p.content_blake3=c.content_blake3
        WHERE c.space_id=$1 AND c.content_blake3=$2 AND p.state IN ('active','retiring')
          AND EXISTS (SELECT 1 FROM backup_holds h WHERE h.space_id=c.space_id
            AND h.backup_id=$3 AND h.history_incarnation=$4)";
    let result: Option<(String, i64, i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SELECT)
                .bind(scope.space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .bind(hold.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(SELECT)
                .bind(scope.space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .bind(hold.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|err| crate::runtime::pg_read_error("held_cas_publication", err))?;
    let Some((publication, raw, compressed, count)) = result else {
        return Err(DomainError::ResourceNotFound.into());
    };
    Ok((
        publication,
        u64::try_from(raw).map_err(|_| invalid_digest())?,
        u64::try_from(compressed).map_err(|_| invalid_digest())?,
        u32::try_from(count).map_err(|_| invalid_digest())?,
    ))
}

async fn attach_versions(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    publication: &str,
    parts: Vec<S3ManifestPart>,
) -> Result<Vec<(S3ManifestPart, Option<String>)>, PortError> {
    let BackendConn::Postgres(conn) = tx else {
        return Err(invalid_digest());
    };
    let versions: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT observed_version_id FROM blob_parts
         WHERE space_id=$1 AND publication_id=$2 ORDER BY part_index",
    )
    .bind(scope.space_id.as_str())
    .bind(publication)
    .fetch_all(&mut **conn)
    .await
    .map_err(|err| crate::runtime::pg_read_error("held_cas_parts", err))?;
    if parts.len() != versions.len() || !valid_publication(publication) {
        return Err(invalid_digest());
    }
    for part in &parts {
        let suffix = format!(
            "spaces/{}/cas-v1/{publication}/{}",
            scope.space_id, part.part_index
        );
        if !part.physical_key.ends_with(&suffix) {
            return Err(invalid_digest());
        }
    }
    Ok(parts.into_iter().zip(versions).collect())
}

fn valid_publication(value: &str) -> bool {
    value
        .strip_prefix("pub_")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|ch| ch.is_ascii_hexdigit()))
}

fn send_frame(
    compressed: impl Read,
    raw_size: u64,
    digest: ContentDigest,
    full: &mut blake3::Hasher,
    output: &mpsc::Sender<Bytes>,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    let mut decoder = zstd::stream::read::Decoder::new(compressed).map_err(stream_io)?;
    decoder.window_log_max(23).map_err(stream_io)?;
    let mut part = blake3::Hasher::new();
    let mut sent = 0_u64;
    let mut buffer = [0; COPY_BUFFER];
    loop {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let read = decoder.read(&mut buffer).map_err(stream_io)?;
        if read == 0 {
            break;
        }
        sent = sent
            .checked_add(read as u64)
            .filter(|value| *value <= raw_size)
            .ok_or_else(invalid_digest)?;
        let bytes = &buffer[..read];
        part.update(bytes);
        full.update(bytes);
        let mut owned = Bytes::copy_from_slice(bytes);
        loop {
            match output.try_send(owned) {
                Ok(()) => break,
                Err(mpsc::error::TrySendError::Full(bytes)) if !cancellation.is_cancelled() => {
                    owned = bytes;
                    std::thread::sleep(Duration::from_micros(250));
                }
                Err(_) => return Err(cancelled()),
            }
        }
    }
    if sent != raw_size || part.finalize().as_bytes() != digest.as_bytes() {
        return Err(invalid_digest());
    }
    Ok(())
}

fn copy_join_error(err: tokio::task::JoinError) -> PortError {
    internal_not_committed("held_cas_worker", err.to_string())
}

fn stream_io(err: std::io::Error) -> PortError {
    internal_not_committed("held_cas_io", err.kind().to_string())
}

fn invalid_digest() -> PortError {
    DomainError::validation(ValidationReason::InvalidDigest).into()
}

fn cancelled() -> PortError {
    cancelled_not_committed("held_cas_cancelled", "held CAS stream cancelled")
}
