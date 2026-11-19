use std::{collections::BTreeMap, sync::Arc, time::Duration};

use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use http::Method;
use notarium_core::{
    DomainError,
    error::{PortError, RetryAdvice, ValidationReason},
    ids::{ContentDigest, LeaseEpoch},
    model::HistoryScope,
};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use quick_xml::{events::Event, reader::Reader};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, macros::format_description};
use url::Url;

use crate::{
    BoxFuture, CanonicalStore,
    blobs::{
        PreparedBlobPart, RetirementTargetRow, S3ManifestPart, TerminalMarkerMeta,
        decode_zstd_verified, ensure_no_backup_holds_tx, lock_and_check_space_tx,
        mark_retirement_target_completed_tx, persist_s3_target_version_ids_tx,
    },
    codec::{internal_not_committed, new_prefixed_hex_id, unavailable_retryable},
    config::{S3AddressingStyle, S3BucketMode, S3BucketModePolicy, S3Config, S3Credentials},
};

const PROBE_DIRECTORY: &str = ".notarium-conformance-probe";

type HmacSha256 = Hmac<Sha256>;

/// RFC 3986 unreserved characters: `[A-Za-z0-9-._~]` stay unencoded; everything else is `%XX`.
const SIGV4_QUERY_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'!')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

const SIGV4_PATH_SEGMENT_ENCODE_SET: &AsciiSet = SIGV4_QUERY_ENCODE_SET;

#[derive(Clone, Debug)]
pub struct S3RawRequest {
    pub method: Method,
    /// `None` targets the bucket root (e.g. `GetBucketVersioning`, `ListObjectVersions`, `CreateBucket`).
    pub key: Option<String>,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

#[derive(Clone, Debug)]
pub struct S3RawResponse {
    pub status: u16,
    /// Lowercased HTTP response headers.
    pub headers: BTreeMap<String, String>,
    pub body: Bytes,
}

impl S3RawResponse {
    pub fn version_id(&self) -> Option<String> {
        self.headers
            .get("x-amz-version-id")
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty() && s != "null")
    }
}

/// Abstract S3 HTTP transport allowing deterministic fault-injection wrappers in L2/L5 suites
/// while executing real SigV4 requests against MinIO CE / S3 endpoints.
pub trait S3Transport: Send + Sync + std::fmt::Debug {
    fn send<'a>(&'a self, req: S3RawRequest) -> BoxFuture<'a, Result<S3RawResponse, PortError>>;
    fn send_bounded<'a>(
        &'a self,
        req: S3RawRequest,
        limit: usize,
    ) -> BoxFuture<'a, Result<S3RawResponse, PortError>> {
        Box::pin(async move {
            let response = self.send(req).await?;
            if response.body.len() > limit {
                return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
            }
            Ok(response)
        })
    }
}

/// Pure-Rust `reqwest` + `rustls` (`ring`) + AWS SigV4 S3 transport.
pub struct ReqwestS3Transport {
    client: reqwest::Client,
    base_url: Url,
    region: String,
    bucket: String,
    addressing: S3AddressingStyle,
    credentials: S3Credentials,
}

impl std::fmt::Debug for ReqwestS3Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReqwestS3Transport")
            .field("endpoint", &self.base_url.as_str())
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("addressing", &self.addressing)
            .finish_non_exhaustive()
    }
}

impl ReqwestS3Transport {
    pub fn new(config: &S3Config) -> Result<Self, PortError> {
        let _ = rustls::crypto::ring::default_provider().install_default();

        if config.bucket.is_empty() || config.region.is_empty() {
            return Err(DomainError::validation(ValidationReason::InvalidId).into());
        }

        let base_url = Url::parse(&config.endpoint)
            .map_err(|err| internal_not_committed("s3_invalid_endpoint_url", format!("{err}")))?;
        if base_url.scheme() != "http" && base_url.scheme() != "https" {
            return Err(internal_not_committed(
                "s3_invalid_endpoint_scheme",
                format!("unsupported scheme '{}'", base_url.scheme()),
            ));
        }

        let mut builder = reqwest::Client::builder()
            .timeout(config.request_timeout)
            .redirect(reqwest::redirect::Policy::none());

        if let Some(ca_pem) = &config.custom_ca_pem {
            let cert = reqwest::Certificate::from_pem(ca_pem).map_err(|err| {
                internal_not_committed("s3_invalid_custom_ca_pem", err.to_string())
            })?;
            builder = builder.add_root_certificate(cert);
        }

        #[cfg(unix)]
        if let Some(sock_path) = &config.unix_socket {
            builder = builder.unix_socket(sock_path.clone());
        }

        let client = builder
            .build()
            .map_err(|err| internal_not_committed("s3_build_http_client", err.to_string()))?;

        Ok(Self {
            client,
            base_url,
            region: config.region.clone(),
            bucket: config.bucket.clone(),
            addressing: config.addressing,
            credentials: config.credentials.clone(),
        })
    }
}

impl S3Transport for ReqwestS3Transport {
    fn send<'a>(&'a self, req: S3RawRequest) -> BoxFuture<'a, Result<S3RawResponse, PortError>> {
        self.send_bounded(req, usize::MAX)
    }

    fn send_bounded<'a>(
        &'a self,
        req: S3RawRequest,
        limit: usize,
    ) -> BoxFuture<'a, Result<S3RawResponse, PortError>> {
        Box::pin(async move {
            forbid_multipart_and_copy(&req)?;

            let now = OffsetDateTime::now_utc();
            let amz_date = format_amz_date(now)?;
            let date_stamp = &amz_date[..8];

            let (request_url, host_header, canonical_uri) = build_target_url_and_host(
                &self.base_url,
                &self.bucket,
                self.addressing,
                req.key.as_deref(),
                &req.query,
            )?;

            let payload_hash = hex::encode(Sha256::digest(&req.body));
            let content_length = req.body.len().to_string();

            let mut headers_map: BTreeMap<String, String> = BTreeMap::new();
            headers_map.insert("host".to_owned(), host_header.clone());
            headers_map.insert("x-amz-content-sha256".to_owned(), payload_hash.clone());
            headers_map.insert("x-amz-date".to_owned(), amz_date.clone());
            if req.method == Method::PUT || req.method == Method::POST || !req.body.is_empty() {
                headers_map.insert("content-length".to_owned(), content_length);
            }
            if let Some(token) = &self.credentials.session_token {
                headers_map.insert("x-amz-security-token".to_owned(), token.trim().to_owned());
            }
            for (k, v) in &req.headers {
                headers_map.insert(k.to_ascii_lowercase(), v.trim().to_owned());
            }

            let canonical_query = encode_canonical_query(&req.query);
            let auth_header = compute_sigv4_authorization(
                req.method.as_str(),
                &canonical_uri,
                &canonical_query,
                &headers_map,
                &payload_hash,
                &amz_date,
                date_stamp,
                &self.region,
                &self.credentials,
            )?;

            let mut rb = self
                .client
                .request(req.method.clone(), request_url)
                .header("authorization", auth_header);

            for (k, v) in &headers_map {
                rb = rb.header(k.as_str(), v.as_str());
            }
            if !req.body.is_empty() || req.method == Method::PUT || req.method == Method::POST {
                rb = rb.body(req.body);
            }

            let mut resp = rb.send().await.map_err(|err| {
                unavailable_retryable(
                    "s3_http_send_failed",
                    err.to_string(),
                    Duration::from_millis(50),
                )
            })?;

            let status = resp.status().as_u16();
            let mut resp_headers = BTreeMap::new();
            for (name, val) in resp.headers() {
                if let Ok(v_str) = val.to_str() {
                    resp_headers.insert(name.as_str().to_ascii_lowercase(), v_str.to_owned());
                }
            }

            // The status already disproves conformance. Its optional error body
            // cannot turn a rejected GET into a retryable, incomplete response.
            let rejected_probe = status != 200
                && req.method == Method::GET
                && req
                    .key
                    .as_deref()
                    .and_then(|key| key.rsplit_once('/'))
                    .is_some_and(|(directory, _)| {
                        directory.rsplit('/').next() == Some(PROBE_DIRECTORY)
                    });
            let read_error = |err: reqwest::Error| {
                unavailable_retryable(
                    "s3_http_read_body",
                    err.to_string(),
                    Duration::from_millis(50),
                )
            };
            let body = if rejected_probe {
                Bytes::new()
            } else if limit != usize::MAX {
                let exceeded = || DomainError::validation(ValidationReason::BudgetExceeded);
                if resp.content_length().is_some_and(|len| len > limit as u64) {
                    return Err(exceeded().into());
                }
                let mut bytes = bytes::BytesMut::new();
                while let Some(chunk) = resp.chunk().await.map_err(read_error)? {
                    if chunk.len() > limit.saturating_sub(bytes.len()) {
                        return Err(exceeded().into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                bytes.freeze()
            } else {
                resp.bytes().await.map_err(read_error)?
            };

            Ok(S3RawResponse {
                status,
                headers: resp_headers,
                body,
            })
        })
    }
}

fn forbid_multipart_and_copy(req: &S3RawRequest) -> Result<(), PortError> {
    for (q_k, _) in &req.query {
        let lower = q_k.to_ascii_lowercase();
        if lower == "uploads" || lower == "uploadid" || lower == "partnumber" {
            return Err(internal_not_committed(
                "s3_forbidden_multipart_api",
                format!("multipart query parameter '{q_k}' is forbidden in S3ChunkedV1 CAS"),
            ));
        }
    }
    for (h_k, _) in &req.headers {
        if h_k.eq_ignore_ascii_case("x-amz-copy-source") {
            return Err(internal_not_committed(
                "s3_forbidden_copy_object",
                "CopyObject is forbidden in S3ChunkedV1 CAS",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct S3ObjectVersionEntry {
    pub key: String,
    pub version_id: String,
    pub is_latest: bool,
    pub is_delete_marker: bool,
}

#[derive(Debug)]
pub struct S3BlobStore {
    config: S3Config,
    normalized_prefix: String,
    bucket_mode: S3BucketMode,
    transport: Arc<dyn S3Transport>,
}

impl S3BlobStore {
    pub async fn open(
        config: S3Config,
        custom_transport: Option<Arc<dyn S3Transport>>,
    ) -> Result<Self, PortError> {
        let transport: Arc<dyn S3Transport> = match custom_transport {
            Some(t) => t,
            None => Arc::new(ReqwestS3Transport::new(&config)?),
        };

        let normalized_prefix = normalize_app_prefix(&config.application_prefix)?;
        let bucket_mode =
            resolve_bucket_mode(transport.as_ref(), config.bucket_mode_policy).await?;

        let store = Self {
            config,
            normalized_prefix,
            bucket_mode,
            transport,
        };

        store.run_conformance_probe().await?;
        Ok(store)
    }

    pub fn application_prefix(&self) -> &str {
        &self.normalized_prefix
    }

    pub fn overlaps_namespace(&self, other: &Self) -> bool {
        // Compare bucket names independently of endpoint aliases. An empty
        // prefix covers the entire bucket, and prefixes end at a boundary.
        self.config.bucket == other.config.bucket
            && (self.normalized_prefix.starts_with(&other.normalized_prefix)
                || other.normalized_prefix.starts_with(&self.normalized_prefix))
    }

    pub fn bucket_mode(&self) -> S3BucketMode {
        self.bucket_mode
    }

    pub fn transport(&self) -> &Arc<dyn S3Transport> {
        &self.transport
    }

    /// Re-verifies at runtime that the bucket versioning mode has not drifted or been suspended.
    pub async fn verify_runtime_bucket_mode(&self) -> Result<(), PortError> {
        let current =
            resolve_bucket_mode(self.transport.as_ref(), self.config.bucket_mode_policy).await?;
        if current != self.bucket_mode {
            return Err(internal_not_committed(
                "s3_bucket_mode_drift",
                format!(
                    "S3 bucket mode changed during runtime from {:?} to {:?}",
                    self.bucket_mode, current
                ),
            ));
        }
        Ok(())
    }

    async fn read_conformance_probe(&self, key: &str) -> Result<S3RawResponse, PortError> {
        let read = || {
            self.transport.send(S3RawRequest {
                method: Method::GET,
                key: Some(key.to_owned()),
                query: Vec::new(),
                headers: Vec::new(),
                body: Bytes::new(),
            })
        };
        let started = tokio::time::Instant::now();
        let budget = self.config.request_timeout;
        let result = tokio::time::timeout(budget, read()).await.map_err(|_| {
            unavailable_retryable(
                "s3_conformance_read_timeout",
                "origin GET timed out",
                Duration::from_millis(50),
            )
        })?;
        let Err(error @ PortError::Unavailable(failure)) = result else {
            return result;
        };
        let delay = match failure.retry() {
            RetryAdvice::Never => return Err(error),
            RetryAdvice::RetrySameCommand => Duration::ZERO,
            RetryAdvice::After(delay) => delay,
        };
        let remaining = budget.saturating_sub(started.elapsed());
        if delay >= remaining {
            return Err(error);
        }
        tokio::time::timeout(remaining, async {
            tokio::time::sleep(delay).await;
            read().await
        })
        .await
        .unwrap_or(Err(error))
    }

    /// Verifies atomic `PutObject` `If-None-Match: *` and strong origin read-after-write on startup.
    /// Rejects endpoints or negative-control doubles that silently ignore conditional headers.
    pub async fn run_conformance_probe(&self) -> Result<(), PortError> {
        let probe_id = new_prefixed_hex_id("prb_")?;
        let probe_key = format!("{}{PROBE_DIRECTORY}/{probe_id}", self.normalized_prefix);
        let payload_a = Bytes::from_static(b"notarium-s3-conformance-probe-v1-a");
        let payload_b = Bytes::from_static(b"notarium-s3-conformance-probe-v1-b");

        let first = self
            .transport
            .send(S3RawRequest {
                method: Method::PUT,
                key: Some(probe_key.clone()),
                query: Vec::new(),
                headers: vec![("if-none-match".to_owned(), "*".to_owned())],
                body: payload_a.clone(),
            })
            .await?;

        if first.status != 200 && first.status != 201 {
            return Err(internal_not_committed(
                "s3_conformance_put_failed",
                format!("initial conditional PUT returned HTTP {}", first.status),
            ));
        }
        let first_vid = first.version_id();

        let second = self
            .transport
            .send(S3RawRequest {
                method: Method::PUT,
                key: Some(probe_key.clone()),
                query: Vec::new(),
                headers: vec![("if-none-match".to_owned(), "*".to_owned())],
                body: payload_b,
            })
            .await?;

        let get_back = self.read_conformance_probe(&probe_key).await;

        // Best-effort cleanup of the dedicated conformance probe object (outside `spaces/*/cas-v1/`).
        let cleanup_query = match (self.bucket_mode, first_vid.as_deref()) {
            (S3BucketMode::Enabled, Some(vid)) => vec![("versionId".to_owned(), vid.to_owned())],
            _ => Vec::new(),
        };
        let _ = self
            .transport
            .send(S3RawRequest {
                method: Method::DELETE,
                key: Some(probe_key),
                query: cleanup_query,
                headers: Vec::new(),
                body: Bytes::new(),
            })
            .await;

        if second.status != 412 && second.status != 409 {
            return Err(internal_not_committed(
                "s3_conditional_put_ignored",
                format!(
                    "duplicate PUT with If-None-Match: * returned HTTP {} instead of 412/409",
                    second.status
                ),
            ));
        }
        let get_back = get_back?;
        if get_back.status != 200 || get_back.body != payload_a {
            return Err(internal_not_committed(
                "s3_conformance_read_after_write_failed",
                format!(
                    "origin GET after duplicate conditional PUT returned HTTP {} (len {})",
                    get_back.status,
                    get_back.body.len()
                ),
            ));
        }

        Ok(())
    }

    /// Uploads a single `S3ChunkedV1` part strictly with `If-None-Match: *`, reconciling via
    /// cryptographic origin `GET` on `412`/`409` or lost transport responses.
    pub async fn put_part_if_absent_or_reconcile(
        &self,
        physical_key: &str,
        part: &PreparedBlobPart,
    ) -> Result<Option<String>, PortError> {
        self.ensure_valid_cas_key(physical_key)?;

        let put_req = S3RawRequest {
            method: Method::PUT,
            key: Some(physical_key.to_owned()),
            query: Vec::new(),
            headers: vec![
                ("if-none-match".to_owned(), "*".to_owned()),
                (
                    "content-type".to_owned(),
                    "application/octet-stream".to_owned(),
                ),
            ],
            body: Bytes::copy_from_slice(&part.compressed),
        };

        match self.transport.send(put_req).await {
            Ok(resp) if resp.status == 200 || resp.status == 201 => Ok(resp.version_id()),
            Ok(resp) if resp.status == 412 || resp.status == 409 => {
                self.reconcile_registered_part(physical_key, part).await
            }
            Ok(resp) => Err(unavailable_retryable(
                "s3_put_part_http_error",
                format!("S3 PUT part returned HTTP {}", resp.status),
                Duration::from_millis(50),
            )),
            Err(transport_err) => {
                // Response may have been lost after S3 committed the object; reconcile from origin!
                match self.reconcile_registered_part(physical_key, part).await {
                    Ok(vid) => Ok(vid),
                    Err(reconcile_err) => {
                        // If the key was fenced by a terminal marker, surface the fence error;
                        // otherwise return the retryable transport error.
                        let fenced_diag = crate::codec::diagnostic_digest(
                            "s3_part_fenced_by_terminal_marker",
                            "S3 publication was retired and fenced by terminal marker",
                        );
                        if matches!(
                            &reconcile_err,
                            PortError::Unavailable(f) if f.diagnostic_ref() == fenced_diag
                        ) {
                            Err(reconcile_err)
                        } else {
                            Err(transport_err)
                        }
                    }
                }
            }
        }
    }

    async fn reconcile_registered_part(
        &self,
        physical_key: &str,
        part: &PreparedBlobPart,
    ) -> Result<Option<String>, PortError> {
        let resp = self
            .transport
            .send(S3RawRequest {
                method: Method::GET,
                key: Some(physical_key.to_owned()),
                query: Vec::new(),
                headers: Vec::new(),
                body: Bytes::new(),
            })
            .await?;

        if resp.status == 404 {
            return Err(unavailable_retryable(
                "s3_reconcile_part_absent",
                "registered S3 part absent during reconciliation",
                Duration::from_millis(25),
            ));
        }
        if resp.status != 200 {
            return Err(unavailable_retryable(
                "s3_reconcile_part_http_error",
                format!(
                    "origin GET during reconciliation returned HTTP {}",
                    resp.status
                ),
                Duration::from_millis(50),
            ));
        }

        if TerminalMarkerMeta::is_terminal_marker(&resp.body) {
            return Err(unavailable_retryable(
                "s3_part_fenced_by_terminal_marker",
                "S3 publication was retired and fenced by terminal marker",
                Duration::from_millis(25),
            ));
        }

        // Full cryptographic verification: compressed length + bounded Zstd + raw length + BLAKE3.
        decode_zstd_verified(
            &resp.body,
            Some(part.compressed.len() as u64),
            part.raw_size,
            part.part_blake3,
        )?;

        Ok(resp.version_id())
    }

    /// Reads all ordered `S3ManifestPart`s, verifies each chunk + total raw length + total `BLAKE3`.
    pub async fn read_verified_chunked(
        &self,
        expected_total_digest: ContentDigest,
        expected_total_raw_size: u64,
        parts: &[S3ManifestPart],
    ) -> Result<Vec<u8>, PortError> {
        if parts.is_empty() {
            return Err(internal_not_committed(
                "corrupt_s3_empty_manifest",
                "S3ChunkedV1 manifest must contain at least 1 part",
            ));
        }

        let total_cap = usize::try_from(expected_total_raw_size).map_err(|_| {
            internal_not_committed("corrupt_s3_total_raw_size", "raw_size exceeds usize")
        })?;
        let mut assembled = Vec::with_capacity(total_cap.min(256 * 1024));
        let mut total_hasher = blake3::Hasher::new();

        for (expected_idx, part) in parts.iter().enumerate() {
            if part.part_index as usize != expected_idx {
                return Err(internal_not_committed(
                    "corrupt_s3_part_order",
                    format!(
                        "manifest part order mismatch: expected {expected_idx}, got {}",
                        part.part_index
                    ),
                ));
            }
            self.ensure_valid_cas_key(&part.physical_key)?;

            let resp = self
                .transport
                .send(S3RawRequest {
                    method: Method::GET,
                    key: Some(part.physical_key.clone()),
                    query: Vec::new(),
                    headers: Vec::new(),
                    body: Bytes::new(),
                })
                .await?;

            if resp.status == 404 {
                return Err(internal_not_committed(
                    "corrupt_s3_missing_object",
                    format!("referenced S3 part missing at '{}'", part.physical_key),
                ));
            }
            if resp.status != 200 {
                return Err(unavailable_retryable(
                    "s3_read_part_http_error",
                    format!("S3 GET returned HTTP {}", resp.status),
                    Duration::from_millis(50),
                ));
            }
            if TerminalMarkerMeta::is_terminal_marker(&resp.body) {
                return Err(internal_not_committed(
                    "corrupt_s3_retired_marker_on_active_read",
                    format!(
                        "active S3 manifest key '{}' contains terminal retirement marker",
                        part.physical_key
                    ),
                ));
            }

            let chunk = decode_zstd_verified(
                &resp.body,
                Some(part.compressed_size),
                part.raw_size,
                part.part_blake3,
            )?;
            total_hasher.update(&chunk);
            assembled.extend_from_slice(&chunk);
        }

        if assembled.len() as u64 != expected_total_raw_size {
            return Err(internal_not_committed(
                "corrupt_s3_assembled_size",
                format!(
                    "expected total raw size {expected_total_raw_size}, assembled {}",
                    assembled.len()
                ),
            ));
        }

        let actual_total = ContentDigest::from_bytes(*total_hasher.finalize().as_bytes());
        if actual_total != expected_total_digest {
            return Err(internal_not_committed(
                "corrupt_s3_total_digest",
                format!(
                    "expected total digest {}, assembled {}",
                    expected_total_digest.to_hex(),
                    actual_total.to_hex()
                ),
            ));
        }

        Ok(assembled)
    }

    /// Executes durable retirement & fencing on a single registered `S3ChunkedV1` part key.
    pub async fn execute_target_retirement(
        &self,
        store: &CanonicalStore,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        retirement_id: &str,
        target: &RetirementTargetRow,
        marker: &TerminalMarkerMeta,
    ) -> Result<(), PortError> {
        self.ensure_valid_cas_key(&target.physical_key)?;
        let marker_bytes = Bytes::from(marker.encode()?);

        // Re-verify Space epoch & zero backup holds before issuing S3 retirement I/O.
        let scope_pre = scope.clone();
        let private_upload = retirement_id == target.publication_id;
        store
            .with_read_tx(|tx| {
                Box::pin(async move {
                    let rec = crate::runtime::load_space_record(tx, &scope_pre.space_id).await?;
                    rec.scope.check(&scope_pre)?;
                    if rec.active_epoch != active_epoch {
                        return Err(
                            DomainError::validation(ValidationReason::InvalidAuthority).into()
                        );
                    }
                    if !private_upload {
                        ensure_no_backup_holds_tx(tx, &scope_pre.space_id).await?;
                    }
                    Ok(())
                })
            })
            .await?;

        // Step 1: Write unconditional normal-object terminal marker (fences any future If-None-Match:* PUT).
        let marker_version = self
            .put_terminal_marker(&target.physical_key, marker_bytes.clone())
            .await?;

        match self.bucket_mode {
            S3BucketMode::NeverVersioned => {
                if marker_version.is_some() {
                    return Err(internal_not_committed(
                        "s3_bucket_mode_drift",
                        "versioned marker on a NeverVersioned bucket",
                    ));
                }
                // Verify origin GET returns the terminal marker (never data bytes or 404).
                let head_bytes = self.get_object_bytes(&target.physical_key, None).await?;
                if !TerminalMarkerMeta::is_terminal_marker(&head_bytes) {
                    return Err(unavailable_retryable(
                        "s3_marker_verify_failed",
                        "origin GET after marker overwrite did not return terminal marker",
                        Duration::from_millis(50),
                    ));
                }

                self.verify_runtime_bucket_mode().await?;
                let scope_done = scope.clone();
                let ret_done = retirement_id.to_owned();
                let pub_done = target.publication_id.clone();
                let part_idx = target.part_index;
                store
                    .with_write_tx(|tx| {
                        Box::pin(async move {
                            lock_and_check_space_tx(tx, &scope_done, active_epoch).await?;
                            mark_retirement_target_completed_tx(
                                tx,
                                &scope_done.space_id,
                                &ret_done,
                                &pub_done,
                                part_idx,
                            )
                            .await
                        })
                    })
                    .await
            }
            S3BucketMode::Enabled => {
                // Step 2: List all versions of this exact physical key; ensure latest is a terminal marker.
                let mut versions = self.list_exact_key_versions(&target.physical_key).await?;
                let latest_is_marker = match versions.iter().find(|v| v.is_latest) {
                    Some(latest) if !latest.is_delete_marker => {
                        let body = self
                            .get_object_bytes(&target.physical_key, Some(&latest.version_id))
                            .await?;
                        TerminalMarkerMeta::is_terminal_marker(&body)
                    }
                    _ => false,
                };

                if !latest_is_marker {
                    self.put_terminal_marker(&target.physical_key, marker_bytes)
                        .await?;
                    versions = self.list_exact_key_versions(&target.physical_key).await?;
                }

                let mut data_vids: Vec<String> =
                    target.data_version_ids.clone().unwrap_or_default();

                for entry in &versions {
                    if entry.is_delete_marker {
                        return Err(internal_not_committed(
                            "s3_unexpected_delete_marker",
                            format!(
                                "unexpected S3 DeleteMarker '{}' on CAS key '{}'",
                                entry.version_id, target.physical_key
                            ),
                        ));
                    }
                    let body = self
                        .get_object_bytes(&target.physical_key, Some(&entry.version_id))
                        .await?;
                    if !TerminalMarkerMeta::is_terminal_marker(&body)
                        && !data_vids.contains(&entry.version_id)
                    {
                        data_vids.push(entry.version_id.clone());
                    }
                }

                // Step 3: Persist exact data versionIds durably before issuing any exact-version DELETE.
                {
                    let scope_save = scope.clone();
                    let ret_save = retirement_id.to_owned();
                    let pub_save = target.publication_id.clone();
                    let part_idx = target.part_index;
                    let vids_save = data_vids.clone();
                    store
                        .with_write_tx(|tx| {
                            Box::pin(async move {
                                lock_and_check_space_tx(tx, &scope_save, active_epoch).await?;
                                persist_s3_target_version_ids_tx(
                                    tx,
                                    &scope_save.space_id,
                                    &ret_save,
                                    &pub_save,
                                    part_idx,
                                    &vids_save,
                                )
                                .await
                            })
                        })
                        .await?;
                }

                // Step 4: Delete ONLY exact non-marker data versionIds (never marker versions, never unversioned DELETE).
                for vid in &data_vids {
                    self.delete_exact_version(&target.physical_key, vid).await?;
                }

                // Step 5: Re-list and verify current marker is latest AND zero non-marker data versions remain.
                let post_versions = self.list_exact_key_versions(&target.physical_key).await?;
                if post_versions.is_empty() {
                    return Err(unavailable_retryable(
                        "s3_retirement_missing_marker",
                        "no versions found after S3 retirement; terminal marker must remain",
                        Duration::from_millis(50),
                    ));
                }
                let mut saw_latest_marker = false;
                for entry in &post_versions {
                    if entry.is_delete_marker {
                        return Err(internal_not_committed(
                            "s3_post_retire_delete_marker",
                            format!("DeleteMarker found on '{}'", target.physical_key),
                        ));
                    }
                    let body = self
                        .get_object_bytes(&target.physical_key, Some(&entry.version_id))
                        .await?;
                    if !TerminalMarkerMeta::is_terminal_marker(&body) {
                        return Err(unavailable_retryable(
                            "s3_data_version_survived_delete",
                            format!(
                                "non-marker data version '{}' still present on '{}'",
                                entry.version_id, target.physical_key
                            ),
                            Duration::from_millis(50),
                        ));
                    }
                    if entry.is_latest {
                        saw_latest_marker = true;
                    }
                }
                if !saw_latest_marker {
                    return Err(unavailable_retryable(
                        "s3_latest_version_not_marker",
                        "latest version on retired S3 key is not a verified terminal marker",
                        Duration::from_millis(50),
                    ));
                }

                self.verify_runtime_bucket_mode().await?;
                let scope_done = scope.clone();
                let ret_done = retirement_id.to_owned();
                let pub_done = target.publication_id.clone();
                let part_idx = target.part_index;
                store
                    .with_write_tx(|tx| {
                        Box::pin(async move {
                            lock_and_check_space_tx(tx, &scope_done, active_epoch).await?;
                            mark_retirement_target_completed_tx(
                                tx,
                                &scope_done.space_id,
                                &ret_done,
                                &pub_done,
                                part_idx,
                            )
                            .await
                        })
                    })
                    .await
            }
        }
    }

    async fn put_terminal_marker(
        &self,
        physical_key: &str,
        marker_bytes: Bytes,
    ) -> Result<Option<String>, PortError> {
        let resp = self
            .transport
            .send(S3RawRequest {
                method: Method::PUT,
                key: Some(physical_key.to_owned()),
                query: Vec::new(),
                headers: vec![(
                    "content-type".to_owned(),
                    "application/octet-stream".to_owned(),
                )],
                body: marker_bytes,
            })
            .await?;

        if resp.status != 200 && resp.status != 201 {
            return Err(unavailable_retryable(
                "s3_put_terminal_marker_failed",
                format!("terminal marker PUT returned HTTP {}", resp.status),
                Duration::from_millis(50),
            ));
        }
        Ok(resp.version_id())
    }

    async fn get_object_bytes(
        &self,
        physical_key: &str,
        version_id: Option<&str>,
    ) -> Result<Bytes, PortError> {
        let mut query = Vec::new();
        if let Some(vid) = version_id {
            query.push(("versionId".to_owned(), vid.to_owned()));
        }
        let resp = self
            .transport
            .send(S3RawRequest {
                method: Method::GET,
                key: Some(physical_key.to_owned()),
                query,
                headers: Vec::new(),
                body: Bytes::new(),
            })
            .await?;

        if resp.status != 200 {
            return Err(unavailable_retryable(
                "s3_get_object_failed",
                format!("S3 GET '{}' returned HTTP {}", physical_key, resp.status),
                Duration::from_millis(50),
            ));
        }
        Ok(resp.body)
    }

    async fn delete_exact_version(
        &self,
        physical_key: &str,
        version_id: &str,
    ) -> Result<(), PortError> {
        if version_id.is_empty() {
            return Err(internal_not_committed(
                "s3_invalid_exact_version_delete",
                "refusing S3 DeleteObject without an explicit versionId",
            ));
        }
        let resp = self
            .transport
            .send(S3RawRequest {
                method: Method::DELETE,
                key: Some(physical_key.to_owned()),
                query: vec![("versionId".to_owned(), version_id.to_owned())],
                headers: Vec::new(),
                body: Bytes::new(),
            })
            .await?;

        if resp.status != 200 && resp.status != 204 && resp.status != 404 {
            return Err(unavailable_retryable(
                "s3_delete_version_failed",
                format!(
                    "S3 DELETE versionId='{}' returned HTTP {}",
                    version_id, resp.status
                ),
                Duration::from_millis(50),
            ));
        }
        Ok(())
    }

    pub async fn list_exact_key_versions(
        &self,
        physical_key: &str,
    ) -> Result<Vec<S3ObjectVersionEntry>, PortError> {
        let mut all = Vec::new();
        let mut key_marker: Option<String> = None;
        let mut version_id_marker: Option<String> = None;

        loop {
            let mut query = vec![
                ("versions".to_owned(), String::new()),
                ("prefix".to_owned(), physical_key.to_owned()),
            ];
            if let Some(km) = &key_marker {
                query.push(("key-marker".to_owned(), km.clone()));
            }
            if let Some(vm) = &version_id_marker {
                query.push(("version-id-marker".to_owned(), vm.clone()));
            }

            let resp = self
                .transport
                .send(S3RawRequest {
                    method: Method::GET,
                    key: None,
                    query,
                    headers: Vec::new(),
                    body: Bytes::new(),
                })
                .await?;

            if resp.status != 200 {
                return Err(unavailable_retryable(
                    "s3_list_versions_failed",
                    format!("ListObjectVersions returned HTTP {}", resp.status),
                    Duration::from_millis(50),
                ));
            }

            let xml_str = std::str::from_utf8(&resp.body)
                .map_err(|err| internal_not_committed("s3_list_versions_utf8", err.to_string()))?;
            let page = parse_list_object_versions_xml(xml_str)?;

            for entry in page.entries {
                if entry.key == physical_key {
                    all.push(entry);
                }
            }

            if page.is_truncated {
                let next_km = page.next_key_marker.ok_or_else(|| {
                    internal_not_committed(
                        "s3_list_versions_missing_marker",
                        "IsTruncated=true without NextKeyMarker",
                    )
                })?;
                key_marker = Some(next_km);
                version_id_marker = page.next_version_id_marker;
            } else {
                break;
            }
        }

        Ok(all)
    }

    fn ensure_valid_cas_key(&self, key: &str) -> Result<(), PortError> {
        let expected_start = format!("{}spaces/", self.normalized_prefix);
        if !key.starts_with(&expected_start) || !key.contains("/cas-v1/") {
            return Err(internal_not_committed(
                "s3_invalid_cas_key",
                format!("key '{key}' outside dedicated CAS prefix '{expected_start}'"),
            ));
        }
        Ok(())
    }
}

/// Helper to create a bucket and optionally set its versioning status (`Enabled` or `Suspended`)
/// against a test fixture or disposable live acceptance bucket.
pub async fn admin_ensure_bucket(
    config: &S3Config,
    versioning_xml_status: Option<&str>,
) -> Result<(), PortError> {
    let transport = ReqwestS3Transport::new(config)?;
    let create_resp = transport
        .send(S3RawRequest {
            method: Method::PUT,
            key: None,
            query: Vec::new(),
            headers: Vec::new(),
            body: Bytes::new(),
        })
        .await?;

    // 200 OK or 409 BucketAlreadyOwnedByYou / BucketAlreadyExists
    if create_resp.status != 200 && create_resp.status != 201 && create_resp.status != 409 {
        return Err(internal_not_committed(
            "s3_admin_create_bucket",
            format!("CreateBucket returned HTTP {}", create_resp.status),
        ));
    }

    if let Some(status) = versioning_xml_status {
        admin_set_bucket_versioning(config, status).await?;
    }
    Ok(())
}

pub async fn admin_set_bucket_versioning(config: &S3Config, status: &str) -> Result<(), PortError> {
    let transport = ReqwestS3Transport::new(config)?;
    let xml = format!(
        "<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Status>{status}</Status></VersioningConfiguration>"
    );
    let resp = transport
        .send(S3RawRequest {
            method: Method::PUT,
            key: None,
            query: vec![("versioning".to_owned(), String::new())],
            headers: vec![("content-type".to_owned(), "application/xml".to_owned())],
            body: Bytes::from(xml),
        })
        .await?;
    if resp.status != 200 && resp.status != 204 {
        return Err(internal_not_committed(
            "s3_admin_put_versioning",
            format!("PutBucketVersioning returned HTTP {}", resp.status),
        ));
    }
    Ok(())
}

/// Durable, non-secret identity used by the Cloud restore readiness gate.
pub fn namespace_fingerprint(
    config: &S3Config,
) -> Result<notarium_core::ids::ContentDigest, PortError> {
    let prefix = normalize_app_prefix(&config.application_prefix)?;
    let identity = format!(
        "{}\n{}\n{}\n{}",
        config.endpoint,
        config.region,
        config.bucket,
        prefix.trim_end_matches('/')
    );
    Ok(notarium_core::ids::ContentDigest::from_bytes(
        *blake3::hash(identity.as_bytes()).as_bytes(),
    ))
}

fn normalize_app_prefix(raw: &str) -> Result<String, PortError> {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.contains("..") || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
    }
    Ok(format!("{trimmed}/"))
}

pub async fn resolve_bucket_mode(
    transport: &dyn S3Transport,
    policy: S3BucketModePolicy,
) -> Result<S3BucketMode, PortError> {
    let resp = transport
        .send(S3RawRequest {
            method: Method::GET,
            key: None,
            query: vec![("versioning".to_owned(), String::new())],
            headers: Vec::new(),
            body: Bytes::new(),
        })
        .await?;

    match resp.status {
        200 => {
            let xml_str = std::str::from_utf8(&resp.body)
                .map_err(|err| internal_not_committed("s3_versioning_xml_utf8", err.to_string()))?;
            let status_opt = parse_bucket_versioning_xml(xml_str)?;
            match status_opt.as_deref() {
                None | Some("") => match policy {
                    S3BucketModePolicy::DetectFromBucket
                    | S3BucketModePolicy::ExplicitNeverVersioned => {
                        Ok(S3BucketMode::NeverVersioned)
                    }
                    S3BucketModePolicy::RequireEnabled => {
                        Err(DomainError::validation(ValidationReason::InvalidState).into())
                    }
                },
                Some("Enabled") => match policy {
                    S3BucketModePolicy::DetectFromBucket | S3BucketModePolicy::RequireEnabled => {
                        Ok(S3BucketMode::Enabled)
                    }
                    S3BucketModePolicy::ExplicitNeverVersioned => Err(internal_not_committed(
                        "s3_explicit_never_versioned_mismatch",
                        "bucket has versioning Enabled while policy requires ExplicitNeverVersioned",
                    )),
                },
                Some("Suspended") => {
                    Err(DomainError::validation(ValidationReason::InvalidState).into())
                }
                Some(other) => Err(internal_not_committed(
                    "s3_unknown_versioning_status",
                    format!("unknown GetBucketVersioning status '{other}'"),
                )),
            }
        }
        403 => {
            // Permission denied is NEVER treated as versionless, even under ExplicitNeverVersioned!
            Err(DomainError::validation(ValidationReason::InvalidAuthority).into())
        }
        400 | 501 => match policy {
            S3BucketModePolicy::ExplicitNeverVersioned => Ok(S3BucketMode::NeverVersioned),
            S3BucketModePolicy::DetectFromBucket | S3BucketModePolicy::RequireEnabled => {
                Err(internal_not_committed(
                    "s3_get_bucket_versioning_unsupported",
                    format!(
                        "GetBucketVersioning returned HTTP {}; use ExplicitNeverVersioned only for verified versionless endpoints",
                        resp.status
                    ),
                ))
            }
        },
        other => Err(unavailable_retryable(
            "s3_get_bucket_versioning_http",
            format!("GetBucketVersioning returned HTTP {other}"),
            Duration::from_millis(50),
        )),
    }
}

fn parse_bucket_versioning_xml(xml: &str) -> Result<Option<String>, PortError> {
    let mut reader = Reader::from_str(xml);
    let mut in_status = false;
    let mut status_val: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                if local_tag_name(e.name().as_ref()) == b"Status" {
                    in_status = true;
                }
            }
            Ok(Event::End(e)) => {
                if local_tag_name(e.name().as_ref()) == b"Status" {
                    in_status = false;
                }
            }
            Ok(Event::Text(e)) if in_status => {
                let decoded = e
                    .decode()
                    .map_err(|err| internal_not_committed("s3_xml_decode", err.to_string()))?;
                let unescaped = quick_xml::escape::unescape(&decoded)
                    .map_err(|err| internal_not_committed("s3_xml_unescape", err.to_string()))?;
                status_val = Some(unescaped.trim().to_owned());
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(err) => {
                return Err(internal_not_committed(
                    "s3_versioning_xml_parse",
                    err.to_string(),
                ));
            }
        }
    }
    Ok(status_val)
}

struct ParsedVersionsPage {
    is_truncated: bool,
    next_key_marker: Option<String>,
    next_version_id_marker: Option<String>,
    entries: Vec<S3ObjectVersionEntry>,
}

fn parse_list_object_versions_xml(xml: &str) -> Result<ParsedVersionsPage, PortError> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Vec<u8>> = Vec::new();

    let mut is_truncated = false;
    let mut next_key_marker = None;
    let mut next_version_id_marker = None;
    let mut entries = Vec::new();

    let mut cur_is_del_marker = false;
    let mut cur_key: Option<String> = None;
    let mut cur_vid: Option<String> = None;
    let mut cur_latest = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = local_tag_name(e.name().as_ref()).to_vec();
                if name == b"Version" {
                    cur_is_del_marker = false;
                    cur_key = None;
                    cur_vid = None;
                    cur_latest = false;
                } else if name == b"DeleteMarker" {
                    cur_is_del_marker = true;
                    cur_key = None;
                    cur_vid = None;
                    cur_latest = false;
                }
                stack.push(name);
            }
            Ok(Event::End(e)) => {
                let raw_name = e.name();
                let name = local_tag_name(raw_name.as_ref());
                if name == b"Version" || name == b"DeleteMarker" {
                    let key = cur_key.take().ok_or_else(|| {
                        internal_not_committed("s3_versions_xml_missing_key", "entry missing Key")
                    })?;
                    let version_id = cur_vid.take().filter(|v| !v.is_empty()).ok_or_else(|| {
                        internal_not_committed(
                            "s3_versions_xml_missing_id",
                            "entry missing VersionId",
                        )
                    })?;
                    entries.push(S3ObjectVersionEntry {
                        key,
                        version_id,
                        is_latest: cur_latest,
                        is_delete_marker: cur_is_del_marker,
                    });
                }
                stack.pop();
            }
            Ok(Event::Text(e)) => {
                let decoded = e
                    .decode()
                    .map_err(|err| internal_not_committed("s3_versions_decode", err.to_string()))?;
                let val = quick_xml::escape::unescape(&decoded)
                    .map_err(|err| internal_not_committed("s3_versions_unescape", err.to_string()))?
                    .into_owned();
                let len = stack.len();
                if len >= 2 {
                    let parent = stack[len - 2].as_slice();
                    let leaf = stack[len - 1].as_slice();
                    if parent == b"ListVersionsResult" {
                        match leaf {
                            b"IsTruncated" => {
                                is_truncated = val.trim().eq_ignore_ascii_case("true");
                            }
                            b"NextKeyMarker" if !val.is_empty() => {
                                next_key_marker = Some(val);
                            }
                            b"NextVersionIdMarker" if !val.is_empty() => {
                                next_version_id_marker = Some(val);
                            }
                            _ => {}
                        }
                    } else if parent == b"Version" || parent == b"DeleteMarker" {
                        match leaf {
                            b"Key" => cur_key = Some(val),
                            b"VersionId" => cur_vid = Some(val.trim().to_owned()),
                            b"IsLatest" => cur_latest = val.trim().eq_ignore_ascii_case("true"),
                            _ => {}
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(err) => {
                return Err(internal_not_committed(
                    "s3_versions_xml_parse",
                    err.to_string(),
                ));
            }
        }
    }

    Ok(ParsedVersionsPage {
        is_truncated,
        next_key_marker,
        next_version_id_marker,
        entries,
    })
}

fn local_tag_name(qname: &[u8]) -> &[u8] {
    match qname.iter().rposition(|b| *b == b':') {
        Some(pos) => &qname[pos + 1..],
        None => qname,
    }
}

fn format_amz_date(now: OffsetDateTime) -> Result<String, PortError> {
    let fmt = format_description!("[year][month][day]T[hour][minute][second]Z");
    now.format(&fmt)
        .map_err(|err| internal_not_committed("s3_format_amz_date", err.to_string()))
}

fn encode_uri_path_segments(segments: &[&str]) -> String {
    if segments.is_empty() {
        return "/".to_owned();
    }
    let mut out = String::new();
    for seg in segments {
        out.push('/');
        out.push_str(&utf8_percent_encode(seg, SIGV4_PATH_SEGMENT_ENCODE_SET).to_string());
    }
    out
}

pub(crate) fn encode_canonical_query(query: &[(String, String)]) -> String {
    if query.is_empty() {
        return String::new();
    }
    let mut encoded_pairs: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| {
            (
                utf8_percent_encode(k, SIGV4_QUERY_ENCODE_SET).to_string(),
                utf8_percent_encode(v, SIGV4_QUERY_ENCODE_SET).to_string(),
            )
        })
        .collect();
    encoded_pairs.sort();
    encoded_pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn build_target_url_and_host(
    base_url: &Url,
    bucket: &str,
    addressing: S3AddressingStyle,
    key: Option<&str>,
    query: &[(String, String)],
) -> Result<(Url, String, String), PortError> {
    let raw_host = base_url.host_str().ok_or_else(|| {
        internal_not_committed("s3_endpoint_missing_host", "endpoint URL missing host")
    })?;
    let port_suffix = match base_url.port() {
        Some(p) => format!(":{p}"),
        None => String::new(),
    };

    let base_prefix_segs: Vec<&str> = base_url
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    let mut path_segs: Vec<&str> = base_prefix_segs;
    let host_header = match addressing {
        S3AddressingStyle::PathStyle => {
            path_segs.push(bucket);
            format!("{raw_host}{port_suffix}")
        }
        S3AddressingStyle::VirtualHosted => {
            format!("{bucket}.{raw_host}{port_suffix}")
        }
    };

    if let Some(k) = key {
        for seg in k.split('/') {
            path_segs.push(seg);
        }
    }

    let canonical_uri = encode_uri_path_segments(&path_segs);
    let canonical_query = encode_canonical_query(query);

    let target_host_url = match addressing {
        S3AddressingStyle::PathStyle => {
            format!("{}://{}{}", base_url.scheme(), host_header, canonical_uri)
        }
        S3AddressingStyle::VirtualHosted => {
            format!("{}://{}{}", base_url.scheme(), host_header, canonical_uri)
        }
    };
    let full_url_str = if canonical_query.is_empty() {
        target_host_url
    } else {
        format!("{target_host_url}?{canonical_query}")
    };

    let parsed = Url::parse(&full_url_str)
        .map_err(|err| internal_not_committed("s3_construct_request_url", err.to_string()))?;

    Ok((parsed, host_header, canonical_uri))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compute_sigv4_authorization(
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &BTreeMap<String, String>,
    payload_sha256_hex: &str,
    amz_date: &str,
    date_stamp: &str,
    region: &str,
    credentials: &S3Credentials,
) -> Result<String, PortError> {
    let mut canonical_headers = String::new();
    let mut signed_names = Vec::with_capacity(headers.len());
    for (k, v) in headers {
        canonical_headers.push_str(k);
        canonical_headers.push(':');
        canonical_headers.push_str(v.trim());
        canonical_headers.push('\n');
        signed_names.push(k.as_str());
    }
    let signed_headers = signed_names.join(";");

    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_sha256_hex}"
    );
    let canonical_request_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));

    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_request_hash}");

    let k_secret = format!("AWS4{}", credentials.secret_access_key);
    let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, b"s3")?;
    let k_signing = hmac_sha256(&k_service, b"aws4_request")?;
    let sig_bytes = hmac_sha256(&k_signing, string_to_sign.as_bytes())?;
    let signature = hex::encode(sig_bytes);

    Ok(format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        credentials.access_key_id
    ))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<[u8; 32], PortError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|err| internal_not_committed("sigv4_hmac_key", err.to_string()))?;
    mac.update(data);
    let out = mac.finalize().into_bytes();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    Ok(arr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn conformance_probe_retries_only_incomplete_reads_within_budget() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        const PAYLOAD: &str = "notarium-s3-conformance-probe-v1-a";
        const PARTIAL_OK: &str = "200 OK\r\nContent-Length: 99\r\n\r\npartial";
        const NOT_FOUND: &str = "404 Not Found\r\nContent-Length: 3\r\n\r\n404";
        const TRUNCATED_ERROR: &str = "503 Unavailable\r\nContent-Length: 99\r\n\r\npartial";
        const WRONG: &str = "200 OK\r\nContent-Length: 5\r\n\r\nwrong";
        let good = format!(
            "200 OK\r\nContent-Length: {}\r\n\r\n{PAYLOAD}",
            PAYLOAD.len()
        );
        for (reads, budget_ms, expected_error) in [
            (vec!["", &good], 2_000, None),
            (vec![PARTIAL_OK, &good], 2_000, None),
            (vec![NOT_FOUND], 2_000, Some("internal")),
            (vec![TRUNCATED_ERROR], 2_000, Some("internal")),
            (vec![WRONG], 2_000, Some("internal")),
            (vec!["", ""], 2_000, Some("unavailable")),
            (vec![""], 35, Some("unavailable")),
        ] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let config = S3Config {
                endpoint: format!("http://{}", listener.local_addr().unwrap()),
                region: "test-region".into(),
                bucket: "probe-test".into(),
                application_prefix: "app".into(),
                addressing: S3AddressingStyle::PathStyle,
                credentials: S3Credentials {
                    access_key_id: "test-key".into(),
                    secret_access_key: "test-secret".into(),
                    session_token: None,
                },
                custom_ca_pem: None,
                unix_socket: None,
                bucket_mode_policy: S3BucketModePolicy::DetectFromBucket,
                request_timeout: Duration::from_millis(budget_ms),
            };
            let transport = Arc::new(ReqwestS3Transport::new(&config).unwrap());
            let store = S3BlobStore {
                config,
                normalized_prefix: "app/".into(),
                bucket_mode: S3BucketMode::NeverVersioned,
                transport,
            };
            let serve = async {
                let mut operations = vec![
                    ("PUT", "200 OK\r\nContent-Length: 0\r\n\r\n"),
                    (
                        "PUT",
                        "412 Precondition Failed\r\nContent-Length: 0\r\n\r\n",
                    ),
                ];
                operations.extend(reads.iter().map(|response| ("GET", *response)));
                operations.push(("DELETE", "204 No Content\r\nContent-Length: 0\r\n\r\n"));
                let mut key = None;
                for (index, (method, response)) in operations.into_iter().enumerate() {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut socket = BufReader::new(socket);
                    let mut line = String::new();
                    socket.read_line(&mut line).await.unwrap();
                    let mut request = line.split_ascii_whitespace();
                    assert_eq!(request.next(), Some(method));
                    let path = request.next().unwrap();
                    assert!(path.contains("/app/.notarium-conformance-probe/prb_"));
                    assert_eq!(key.get_or_insert_with(|| path.to_owned()).as_str(), path);
                    let mut length = 0;
                    let mut conditional = false;
                    loop {
                        line.clear();
                        socket.read_line(&mut line).await.unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        let (name, value) = line.split_once(':').unwrap();
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                        if name.eq_ignore_ascii_case("if-none-match") {
                            conditional = value.trim() == "*";
                        }
                    }
                    let mut body = vec![0; length];
                    socket.read_exact(&mut body).await.unwrap();
                    if method == "PUT" {
                        assert!(conditional);
                        assert_eq!(
                            body,
                            if index == 0 {
                                PAYLOAD.as_bytes()
                            } else {
                                b"notarium-s3-conformance-probe-v1-b"
                            }
                        );
                    }
                    // Empty wire response closes the socket after the server actually read the GET.
                    if !response.is_empty() {
                        socket
                            .get_mut()
                            .write_all(format!("HTTP/1.1 {response}").as_bytes())
                            .await
                            .unwrap();
                    }
                    socket.get_mut().shutdown().await.unwrap();
                }
            };
            let ((), result) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(serve, store.run_conformance_probe())
            })
            .await
            .expect("unexpected number of probe requests");
            assert_eq!(result.err().as_ref().map(PortError::code), expected_error);
        }
    }

    #[test]
    fn sigv4_signing_and_canonical_encoding_deterministic() {
        let q = encode_canonical_query(&[
            ("prefix".to_owned(), "spaces/sp_1/cas-v1/pub_1/0".to_owned()),
            ("versions".to_owned(), String::new()),
        ]);
        assert_eq!(q, "prefix=spaces%2Fsp_1%2Fcas-v1%2Fpub_1%2F0&versions=");

        let mut hdrs = BTreeMap::new();
        hdrs.insert(
            "host".to_owned(),
            "examplebucket.s3.amazonaws.com".to_owned(),
        );
        hdrs.insert(
            "x-amz-content-sha256".to_owned(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
        );
        hdrs.insert("x-amz-date".to_owned(), "20130524T000000Z".to_owned());

        let creds = S3Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".to_owned(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_owned(),
            session_token: None,
        };
        let auth = compute_sigv4_authorization(
            "GET",
            "/test.txt",
            "",
            &hdrs,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "20130524T000000Z",
            "20130524",
            "us-east-1",
            &creds,
        )
        .expect("compute SigV4");
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="
        ));
    }

    #[test]
    fn xml_parsers_handle_versioning_and_paginated_list_versions() {
        assert_eq!(
            parse_bucket_versioning_xml("<VersioningConfiguration/>").unwrap(),
            None
        );
        assert_eq!(
            parse_bucket_versioning_xml(
                "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>"
            )
            .unwrap()
            .as_deref(),
            Some("Enabled")
        );

        let list_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <IsTruncated>true</IsTruncated>
            <NextKeyMarker>spaces/sp_1/cas-v1/pub_1/0</NextKeyMarker>
            <NextVersionIdMarker>v1</NextVersionIdMarker>
            <Version>
                <Key>spaces/sp_1/cas-v1/pub_1/0</Key>
                <VersionId>v2</VersionId>
                <IsLatest>true</IsLatest>
            </Version>
            <Version>
                <Key>spaces/sp_1/cas-v1/pub_1/0</Key>
                <VersionId>v1</VersionId>
                <IsLatest>false</IsLatest>
            </Version>
        </ListVersionsResult>"#;
        let parsed = parse_list_object_versions_xml(list_xml).unwrap();
        assert!(parsed.is_truncated);
        assert_eq!(
            parsed.next_key_marker.as_deref(),
            Some("spaces/sp_1/cas-v1/pub_1/0")
        );
        assert_eq!(parsed.next_version_id_marker.as_deref(), Some("v1"));
        assert_eq!(parsed.entries.len(), 2);
        assert!(parsed.entries[0].is_latest);
        assert_eq!(parsed.entries[0].version_id, "v2");
        assert!(!parsed.entries[1].is_latest);
        assert_eq!(parsed.entries[1].version_id, "v1");
    }
}
