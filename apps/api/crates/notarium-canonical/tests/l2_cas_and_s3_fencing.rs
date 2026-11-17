#![forbid(unsafe_code)]

mod support;

use std::{
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use bytes::Bytes;
use http::Method;
use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec, S3BucketMode,
    S3BucketModePolicy,
    blobs::{
        BlobOwnerKind, BlobReferenceClaim, RetirementReason, TerminalMarkerMeta,
        s3::{
            ReqwestS3Transport, S3RawRequest, S3RawResponse, S3Transport, admin_ensure_bucket,
            admin_set_bucket_versioning,
        },
    },
};
use notarium_core::{
    auth::SpaceKind,
    error::{PortError, ValidationReason},
    ids::{LeaseEpoch, NoteId, SpaceSeq},
    model::HistoryScope,
    ports::{ChangeBroadcast, ChangeRead, ChangeReadResult, EntityId, PageLimit, ServicePurpose},
    receipt::ChangeCursor,
};

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_principal_id, sample_space_id,
};

/// Intercepting S3 transport wrapper over live MinIO CE that audits every S3 API call
/// (enforcing 0 multipart/CopyObject calls and `If-None-Match: *` on all data PUTs)
/// and injects deterministic network faults (lost PUT responses, stripped conditional headers).
#[derive(Debug)]
struct AuditingFaultS3Transport {
    inner: ReqwestS3Transport,
    multipart_or_copy_calls: AtomicUsize,
    unconditional_data_puts: AtomicUsize,
    unversioned_cas_deletes: AtomicUsize,
    strip_if_none_match: AtomicBool,
    drop_next_cas_put_response: AtomicBool,
    versioning_on_next_marker: Mutex<Option<notarium_canonical::S3Config>>,
    recorded_cas_put_keys: Mutex<Vec<String>>,
}

impl AuditingFaultS3Transport {
    fn new(inner: ReqwestS3Transport) -> Arc<Self> {
        Arc::new(Self {
            inner,
            multipart_or_copy_calls: AtomicUsize::new(0),
            unconditional_data_puts: AtomicUsize::new(0),
            unversioned_cas_deletes: AtomicUsize::new(0),
            strip_if_none_match: AtomicBool::new(false),
            drop_next_cas_put_response: AtomicBool::new(false),
            versioning_on_next_marker: Mutex::new(None),
            recorded_cas_put_keys: Mutex::new(Vec::new()),
        })
    }
}

impl S3Transport for AuditingFaultS3Transport {
    fn send<'a>(
        &'a self,
        mut req: S3RawRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<S3RawResponse, PortError>> + Send + 'a>,
    > {
        Box::pin(async move {
            for (qk, _) in &req.query {
                let l = qk.to_ascii_lowercase();
                if l == "uploads" || l == "uploadid" || l == "partnumber" {
                    self.multipart_or_copy_calls.fetch_add(1, Ordering::SeqCst);
                }
            }
            if req
                .headers
                .iter()
                .any(|(hk, _)| hk.eq_ignore_ascii_case("x-amz-copy-source"))
            {
                self.multipart_or_copy_calls.fetch_add(1, Ordering::SeqCst);
            }

            if self.strip_if_none_match.load(Ordering::SeqCst) {
                req.headers
                    .retain(|(hk, _)| !hk.eq_ignore_ascii_case("if-none-match"));
            }

            let is_cas_key = req.key.as_deref().is_some_and(|k| k.contains("/cas-v1/"));

            if is_cas_key && req.method == Method::PUT {
                let is_marker = TerminalMarkerMeta::is_terminal_marker(&req.body);
                if is_marker {
                    let change = self.versioning_on_next_marker.lock().unwrap().take();
                    if let Some(cfg) = change {
                        admin_set_bucket_versioning(&cfg, "Enabled").await?;
                    }
                }
                let has_if_none_match = req
                    .headers
                    .iter()
                    .any(|(hk, hv)| hk.eq_ignore_ascii_case("if-none-match") && hv.trim() == "*");
                if !is_marker && !has_if_none_match {
                    self.unconditional_data_puts.fetch_add(1, Ordering::SeqCst);
                }
                if let Some(k) = &req.key {
                    self.recorded_cas_put_keys.lock().unwrap().push(k.clone());
                }
            }

            if is_cas_key && req.method == Method::DELETE {
                let has_vid = req
                    .query
                    .iter()
                    .any(|(qk, qv)| qk == "versionId" && !qv.is_empty());
                if !has_vid {
                    self.unversioned_cas_deletes.fetch_add(1, Ordering::SeqCst);
                }
            }

            let should_drop_resp = is_cas_key
                && req.method == Method::PUT
                && !TerminalMarkerMeta::is_terminal_marker(&req.body)
                && self
                    .drop_next_cas_put_response
                    .swap(false, Ordering::SeqCst);

            let resp = self.inner.send(req).await?;
            if should_drop_resp {
                return Err(notarium_canonical::codec::unavailable_retryable(
                    "injected_lost_put_response",
                    "simulated network drop after MinIO CE accepted PUT",
                    std::time::Duration::from_millis(10),
                ));
            }
            Ok(resp)
        })
    }
}

async fn init_test_space(store: &CanonicalStore, seed: u8) -> (HistoryScope, LeaseEpoch) {
    let epoch = LeaseEpoch::new(1).unwrap();
    let rec = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed),
            incarnation: sample_incarnation(seed),
            root_folder_id: sample_folder_id(seed),
            slug: format!("space-{seed}"),
            kind: SpaceKind::Personal,
            owner: sample_principal_id(seed),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space");
    (rec.scope, epoch)
}

fn deterministic_large_payload(len: usize, tag: u8) -> Vec<u8> {
    let mut out = vec![0u8; len];
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15 ^ u64::from(tag);
    for chunk in out.chunks_mut(8) {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let bytes = state.to_le_bytes();
        chunk.copy_from_slice(&bytes[..chunk.len()]);
    }
    out
}

async fn run_cas_roundtrip_and_refcount_suite(store: &CanonicalStore, seed: u8) {
    let (scope, epoch) = init_test_space(store, seed).await;

    let (other_scope, _) = init_test_space(store, seed + 100).await;
    let ticket = store
        .stage_blob(&scope, epoch, &store.prepare_blob(b"scoped claim").unwrap())
        .await
        .unwrap();
    let misplaced = store
        .commit_blob_reference_claim(
            &other_scope,
            epoch,
            BlobReferenceClaim {
                owner_kind: BlobOwnerKind::AbilityResource,
                owner_id: notarium_core::ids::AbilityId::from_bytes([seed; 16]).to_string(),
                owner_rev_id: "resource-revision".into(),
                resource_key: "readme".into(),
                ticket: ticket.clone(),
            },
            None,
            None,
        )
        .await;
    assert!(matches!(
        misplaced,
        Err(PortError::Domain(
            notarium_core::DomainError::ResourceNotFound
        ))
    ));
    assert_eq!(
        store
            .get_space(&other_scope.space_id)
            .await
            .unwrap()
            .last_seq,
        SpaceSeq::ZERO
    );
    let ability = notarium_core::ids::AbilityId::from_bytes([seed; 16]);
    store
        .commit_blob_reference_claim(
            &scope,
            epoch,
            BlobReferenceClaim {
                owner_kind: BlobOwnerKind::AbilityResource,
                owner_id: ability.to_string(),
                owner_rev_id: "resource-revision".into(),
                resource_key: "readme".into(),
                ticket,
            },
            None,
            None,
        )
        .await
        .unwrap();
    let before = store.get_space(&scope.space_id).await.unwrap().last_seq;
    assert!(
        store
            .release_blob_owner_references(&scope, epoch, BlobOwnerKind::AbilityResource, "absent")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.get_space(&scope.space_id).await.unwrap().last_seq,
        before
    );
    let ChangeReadResult::Log(page) = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope.clone(),
                    after: SpaceSeq::ZERO,
                },
                through: before,
                limit: PageLimit::new(8).unwrap(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected a change log page")
    };
    assert_eq!(page.changes.len(), 1);
    assert_eq!(page.changes[0].entity, EntityId::Ability(ability));

    // 1. Empty 0B frame, 511B/512B/513B boundaries, and >4 MiB (9 MiB = 3 S3ChunkedV1 parts).
    let payloads: Vec<(&str, Vec<u8>)> = vec![
        ("empty_0b", Vec::new()),
        ("b511", deterministic_large_payload(511, 1)),
        ("b512", deterministic_large_payload(512, 2)),
        ("b513", deterministic_large_payload(513, 3)),
        (
            "multi_chunk_9mib",
            deterministic_large_payload(9 * 1024 * 1024 + 321, 9),
        ),
    ];

    for (idx, (label, raw)) in payloads.iter().enumerate() {
        let prepared = store.prepare_blob(raw).expect("prepare blob");
        let expected_digest =
            notarium_core::ids::ContentDigest::from_bytes(*blake3::hash(raw).as_bytes());
        assert_eq!(
            prepared.digest(),
            expected_digest,
            "{label} digest mismatch"
        );
        assert_eq!(prepared.raw_size(), raw.len() as u64);

        let ticket = store
            .stage_blob(&scope, epoch, &prepared)
            .await
            .unwrap_or_else(|e| panic!("stage_blob failed for {label}: {e:?}"));

        store
            .commit_blob_reference_claim(
                &scope,
                epoch,
                BlobReferenceClaim {
                    owner_kind: BlobOwnerKind::NoteRevision,
                    owner_id: NoteId::from_bytes([idx as u8; 16]).to_string(),
                    owner_rev_id: format!("rev_{label}_1"),
                    resource_key: "carrier".to_owned(),
                    ticket,
                },
                None,
                None,
            )
            .await
            .expect("bind ref claim");

        let decoded = store
            .read_verified_blob(&scope, expected_digest)
            .await
            .unwrap_or_else(|e| panic!("read_verified_blob failed for {label}: {e:?}"));
        assert_eq!(&decoded, raw, "{label} roundtrip bytes differ");
    }

    // 2. Concurrent duplicate writers + shared refcount preservation + retirement when refs reach 0.
    let shared_payload = deterministic_large_payload(64 * 1024, 42);
    let shared_prepared = store.prepare_blob(&shared_payload).unwrap();
    let shared_digest = shared_prepared.digest();

    let mut handles = Vec::new();
    for idx in 0..8u8 {
        let st = store.clone();
        let sc = scope.clone();
        let prep = shared_prepared.clone();
        handles.push(tokio::spawn(async move {
            let ticket = st
                .stage_blob(&sc, epoch, &prep)
                .await
                .expect("concurrent stage");
            st.commit_blob_reference_claim(
                &sc,
                epoch,
                BlobReferenceClaim {
                    owner_kind: BlobOwnerKind::NoteRevision,
                    owner_id: NoteId::from_bytes([100 + idx; 16]).to_string(),
                    owner_rev_id: format!("rev_{idx}"),
                    resource_key: "carrier".to_owned(),
                    ticket,
                },
                None,
                None,
            )
            .await
            .expect("concurrent commit claim");
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    // Release 7 of the 8 owners; shared digest still has 1 live ref -> retirement MUST keep it intact!
    for idx in 0..7u8 {
        let zero = store
            .release_blob_owner_references(
                &scope,
                epoch,
                BlobOwnerKind::NoteRevision,
                &NoteId::from_bytes([100 + idx; 16]).to_string(),
            )
            .await
            .unwrap();
        assert!(zero.is_empty(), "digest still has surviving owner(s)");
    }
    let retired_early = store
        .retire_zero_ref_digests(
            &scope,
            epoch,
            &[shared_digest],
            RetirementReason::Purge,
            None,
        )
        .await
        .unwrap();
    assert!(
        retired_early.is_empty(),
        "shared digest with surviving reference must NOT be retired"
    );
    assert_eq!(
        store
            .read_verified_blob(&scope, shared_digest)
            .await
            .unwrap(),
        shared_payload
    );

    // Release final 8th owner -> ref_count drops to 0 -> retirement removes/fences it!
    let zero_final = store
        .release_blob_owner_references(
            &scope,
            epoch,
            BlobOwnerKind::NoteRevision,
            NoteId::from_bytes([107; 16]).as_str(),
        )
        .await
        .unwrap();
    assert_eq!(zero_final, vec![shared_digest]);

    let retired_ids = store
        .retire_zero_ref_digests(&scope, epoch, &zero_final, RetirementReason::Purge, None)
        .await
        .unwrap();
    assert_eq!(retired_ids.len(), 1);
    assert!(
        store
            .retire_zero_ref_digests(&scope, epoch, &zero_final, RetirementReason::Gc, None)
            .await
            .unwrap()
            .is_empty()
    );
    store
        .drive_retirement_to_completion(&scope, epoch, &retired_ids[0])
        .await
        .unwrap();
    assert!(
        matches!(
            store.read_verified_blob(&scope, shared_digest).await,
            Err(PortError::Domain(
                notarium_core::DomainError::ResourceNotFound
            ))
        ),
        "retired zero-ref blob must no longer be readable"
    );
}

#[tokio::test]
async fn l2_local_cas_sqlite_and_pg_parity_corruption_quarantine_and_symlinks() {
    // 1. SQLite + Local CAS
    let sqlite_root = TempDataRoot::new("l2-sqlite-local");
    let sqlite_cfg =
        CanonicalConfig::local_default(sample_installation_id(10), sqlite_root.data_root());
    let (sqlite_store, sqlite_rt) = CanonicalRuntime::open(sqlite_cfg.clone()).await.unwrap();
    run_cas_roundtrip_and_refcount_suite(&sqlite_store, 10).await;

    // Test corruption detection, missing file detection, quarantine resurrection, and symlink rejection.
    let (scope, epoch) = init_test_space(&sqlite_store, 11).await;
    let payload = b"important canonical note payload for corruption & quarantine test".to_vec();
    let prep = sqlite_store.prepare_blob(&payload).unwrap();
    let ticket = sqlite_store.stage_blob(&scope, epoch, &prep).await.unwrap();
    sqlite_store
        .commit_blob_reference_claim(
            &scope,
            epoch,
            BlobReferenceClaim {
                owner_kind: BlobOwnerKind::NoteRevision,
                owner_id: NoteId::from_bytes([43; 16]).to_string(),
                owner_rev_id: "rev_1".to_owned(),
                resource_key: "carrier".to_owned(),
                ticket,
            },
            None,
            None,
        )
        .await
        .unwrap();

    let physical_path = sqlite_root.data_root().blob(&scope.space_id, prep.digest());
    assert!(physical_path.exists());

    // Tamper physical .zst bytes -> read_verified_blob MUST fail closed!
    let good_compressed = fs::read(&physical_path).unwrap();
    fs::write(&physical_path, b"corrupted-not-zstd").unwrap();
    assert!(
        sqlite_store
            .read_verified_blob(&scope, prep.digest())
            .await
            .is_err(),
        "corrupted local .zst must fail verification"
    );

    // Re-staging the same digest quarantines the corrupted file and restores a valid physical .zst!
    let _restaged = sqlite_store.stage_blob(&scope, epoch, &prep).await.unwrap();
    assert_eq!(
        sqlite_store
            .read_verified_blob(&scope, prep.digest())
            .await
            .unwrap(),
        payload
    );
    drop(_restaged);
    let quarantine_dir = sqlite_root.path().join("blobs/.quarantine");
    let quarantined = quarantine_dir.join(format!(
        "{}.{}.corrupt",
        scope.space_id,
        prep.digest().to_hex()
    ));
    assert!(quarantined.is_file());
    let quarantined_count = fs::read_dir(&quarantine_dir).unwrap().count();
    assert!(
        quarantined_count >= 1,
        "corrupted file must be moved to blobs/.quarantine"
    );

    // Missing file -> fails closed!
    fs::remove_file(&physical_path).unwrap();
    assert!(
        sqlite_store
            .read_verified_blob(&scope, prep.digest())
            .await
            .is_err(),
        "missing physical local .zst must fail closed"
    );

    // Plant symlink at target path -> rejected without following!
    #[cfg(unix)]
    {
        let decoy = sqlite_root.path().join("decoy.zst");
        fs::write(&decoy, &good_compressed).unwrap();
        std::os::unix::fs::symlink(&decoy, &physical_path).unwrap();
        assert!(
            sqlite_store
                .read_verified_blob(&scope, prep.digest())
                .await
                .is_err(),
            "symlinked CAS blob must be rejected"
        );
        assert!(
            sqlite_store.stage_blob(&scope, epoch, &prep).await.is_err(),
            "staging over a planted symlink must fail closed"
        );
        fs::remove_file(&physical_path).unwrap();
    }

    let zero = sqlite_store
        .release_blob_owner_references(
            &scope,
            epoch,
            BlobOwnerKind::NoteRevision,
            NoteId::from_bytes([43; 16]).as_str(),
        )
        .await
        .unwrap();
    fs::create_dir(&physical_path).unwrap();
    assert!(
        sqlite_store
            .retire_zero_ref_digests(&scope, epoch, &zero, RetirementReason::Gc, None)
            .await
            .is_err()
    );
    fs::remove_dir(&physical_path).unwrap();
    fs::write(&physical_path, &good_compressed).unwrap();
    drop(sqlite_store);
    sqlite_rt.shutdown().await.unwrap();
    let (recovered, runtime) = CanonicalRuntime::open(sqlite_cfg).await.unwrap();
    assert_eq!(
        recovered
            .execute_diagnostic_read_sql_for_test(
                None,
                "SELECT COUNT(*) FROM blob_retirements WHERE status = 'pending'"
            )
            .await
            .unwrap(),
        0
    );
    assert!(!physical_path.exists());
    assert!(!quarantined.exists());
    runtime.shutdown().await.unwrap();

    // 2. PostgreSQL 16 + Local CAS parity
    let fixtures = StorageTestFixtures::load_required();
    let pg_schema = fixtures.fresh_pg_schema();
    let pg_blob_root = TempDataRoot::new("l2-pg-local");
    let pg_cfg = fixtures.pg_local_config(
        sample_installation_id(12),
        &pg_schema,
        pg_blob_root.data_root(),
    );
    let (pg_store, pg_rt) = CanonicalRuntime::open(pg_cfg).await.unwrap();
    run_cas_roundtrip_and_refcount_suite(&pg_store, 12).await;
    drop(pg_store);
    pg_rt.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&pg_schema).await;
}

#[tokio::test]
async fn l2_s3_minio_ce_modes_negative_controls_and_fencing_races() {
    let fixtures = StorageTestFixtures::load_required();

    // --- A. Negative Control 1: Suspended bucket mode fails closed at startup ---
    {
        let susp_bucket = fixtures.fresh_s3_bucket("suspended");
        let susp_s3 = fixtures.s3_config(&susp_bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&susp_s3, Some("Suspended"))
            .await
            .expect("create suspended bucket");

        let pg_schema = fixtures.fresh_pg_schema();
        let cfg = fixtures.pg_s3_config(sample_installation_id(20), &pg_schema, susp_s3);
        let res = CanonicalRuntime::open(cfg).await;
        assert_validation_err(&res, ValidationReason::InvalidState);
        fixtures.drop_pg_schema(&pg_schema).await;
    }

    // --- B. Negative Control 2: Stripped/ignored If-None-Match:* fails closed at startup conformance probe ---
    {
        let bad_bucket = fixtures.fresh_s3_bucket("strip-cond");
        let bad_s3 = fixtures.s3_config(&bad_bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&bad_s3, None)
            .await
            .expect("create bucket");

        let bad_transport =
            AuditingFaultS3Transport::new(ReqwestS3Transport::new(&bad_s3).unwrap());
        bad_transport
            .strip_if_none_match
            .store(true, Ordering::SeqCst);

        let pg_schema = fixtures.fresh_pg_schema();
        let cfg = fixtures.pg_s3_config(sample_installation_id(21), &pg_schema, bad_s3);
        let res = CanonicalRuntime::open_with_s3_transport(cfg, Some(bad_transport)).await;
        assert!(
            res.is_err(),
            "S3 backend ignoring If-None-Match:* MUST fail closed during conformance probe"
        );
        fixtures.drop_pg_schema(&pg_schema).await;
    }

    // --- C. Full Fencing & Parity Matrix on BOTH NeverVersioned and Enabled MinIO CE Buckets ---
    for (mode_idx, versioning_xml, expected_mode) in [
        (0u8, None, S3BucketMode::NeverVersioned),
        (1u8, Some("Enabled"), S3BucketMode::Enabled),
    ] {
        let bucket = fixtures.fresh_s3_bucket(match expected_mode {
            S3BucketMode::NeverVersioned => "never-ver",
            S3BucketMode::Enabled => "ver-enabled",
        });
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, versioning_xml)
            .await
            .expect("create MinIO CE test bucket");

        let audit_transport =
            AuditingFaultS3Transport::new(ReqwestS3Transport::new(&s3_cfg).unwrap());
        let pg_schema = fixtures.fresh_pg_schema();
        let cfg = fixtures.pg_s3_config(
            sample_installation_id(30 + mode_idx),
            &pg_schema,
            s3_cfg.clone(),
        );
        let (store, rt) =
            CanonicalRuntime::open_with_s3_transport(cfg.clone(), Some(audit_transport.clone()))
                .await
                .expect("open PG + MinIO CE canonical runtime");

        // 1. Full roundtrip (>4 MiB multi-part, 0B empty frame, shared refcounts, retirement).
        run_cas_roundtrip_and_refcount_suite(&store, 40 + mode_idx).await;

        let (scope, epoch1) = init_test_space(&store, 50 + mode_idx).await;

        // 2. Lost PUT response reconciliation via cryptographic origin GET!
        let lost_payload =
            b"payload surviving lost HTTP PUT response via origin GET reconcile".to_vec();
        let lost_prep = store.prepare_blob(&lost_payload).unwrap();
        audit_transport
            .drop_next_cas_put_response
            .store(true, Ordering::SeqCst);
        let lost_ticket = store
            .stage_blob(&scope, epoch1, &lost_prep)
            .await
            .expect("lost PUT response must reconcile cleanly from origin GET");
        store
            .commit_blob_reference_claim(
                &scope,
                epoch1,
                BlobReferenceClaim {
                    owner_kind: BlobOwnerKind::NoteRevision,
                    owner_id: NoteId::from_bytes([44; 16]).to_string(),
                    owner_rev_id: "rev_lost_1".to_owned(),
                    resource_key: "carrier".to_owned(),
                    ticket: lost_ticket,
                },
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .read_verified_blob(&scope, lost_prep.digest())
                .await
                .unwrap(),
            lost_payload
        );

        // 3. Registered-but-unsent part + delayed stale PUT before/after marker + takeover + same-digest restage!
        let secret_payload = deterministic_large_payload(5 * 1024 * 1024 + 128, 77 + mode_idx); // 2 parts!
        let secret_prep = store.prepare_blob(&secret_payload).unwrap();
        assert_eq!(secret_prep.s3_parts().len(), 2);

        // Simulate a crashed staging attempt that registered publication + 2 parts in PG, uploaded part 0,
        // and NEVER uploaded part 1 (`upload_confirmed = 0`).
        let manual_pub_id = format!("pub_unsent_{mode_idx}");
        let part0_key = format!(
            "spaces/{}/cas-v1/{manual_pub_id}/0",
            scope.space_id.as_str()
        );
        let part1_key = format!(
            "spaces/{}/cas-v1/{manual_pub_id}/1",
            scope.space_id.as_str()
        );
        {
            let mut pg = fixtures.open_raw_pg().await;
            let set_sp = format!("SET search_path TO \"{pg_schema}\"");
            sqlx::query(sqlx::AssertSqlSafe(set_sp))
                .execute(&mut pg)
                .await
                .unwrap();

            sqlx::query(
                "INSERT INTO blob_catalog (
                    space_id, content_blake3, raw_size, compressed_size, ref_count,
                    current_publication_id, admission_state, blob_state, touched_at_ms
                ) VALUES ($1, $2, $3, $4, 0, NULL, 'open', 'staging', 1000)",
            )
            .bind(scope.space_id.as_str())
            .bind(secret_prep.digest().as_bytes().as_slice())
            .bind(secret_prep.raw_size() as i64)
            .bind(secret_prep.compressed_size() as i64)
            .execute(&mut pg)
            .await
            .unwrap();

            sqlx::query(
                "INSERT INTO blob_publications (
                    space_id, publication_id, content_blake3, owner_epoch, codec,
                    state, manifest_sealed, part_count, raw_size, compressed_size,
                    created_at_ms, updated_at_ms
                ) VALUES ($1, $2, $3, 1, 's3_chunked_v1', 'staging', 1, 2, $4, $5, 1000, 1000)",
            )
            .bind(scope.space_id.as_str())
            .bind(&manual_pub_id)
            .bind(secret_prep.digest().as_bytes().as_slice())
            .bind(secret_prep.raw_size() as i64)
            .bind(secret_prep.compressed_size() as i64)
            .execute(&mut pg)
            .await
            .unwrap();

            for (part, key) in [
                (&secret_prep.s3_parts()[0], &part0_key),
                (&secret_prep.s3_parts()[1], &part1_key),
            ] {
                sqlx::query(
                    "INSERT INTO blob_parts (
                        space_id, publication_id, part_index, raw_size, compressed_size,
                        part_blake3, physical_key, observed_version_id, upload_confirmed
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 0)",
                )
                .bind(scope.space_id.as_str())
                .bind(&manual_pub_id)
                .bind(part.part_index as i32)
                .bind(part.raw_size as i64)
                .bind(part.compressed.len() as i64)
                .bind(part.part_blake3.as_bytes().as_slice())
                .bind(key)
                .execute(&mut pg)
                .await
                .unwrap();
            }
            let _ = sqlx::Connection::close(pg).await;
        }

        // Delayed data PUT on part 0 lands BEFORE retirement marker, while part 1 remains unsent!
        let put0_resp = audit_transport
            .send(S3RawRequest {
                method: Method::PUT,
                key: Some(part0_key.clone()),
                query: Vec::new(),
                headers: vec![("if-none-match".to_owned(), "*".to_owned())],
                body: Bytes::copy_from_slice(&secret_prep.s3_parts()[0].compressed),
            })
            .await
            .unwrap();
        assert_eq!(put0_resp.status, 200);
        let stale_part0_vid = put0_resp.version_id();

        // Advance Space lease epoch (takeover to epoch 2) and retire the digest!
        let epoch2 = store
            .advance_space_lease(
                &maintenance_ctx(ServicePurpose::Revocation),
                &scope,
                LeaseEpoch::new(2).unwrap(),
            )
            .await
            .unwrap();

        let ret_ids = store
            .retire_zero_ref_digests(
                &scope,
                epoch2,
                &[secret_prep.digest()],
                RetirementReason::Purge,
                None,
            )
            .await
            .expect("retire incomplete staging publication under new epoch");
        assert_eq!(ret_ids.len(), 1);

        // Now a delayed old-worker data PUT for unsent part 1 arrives AFTER marker: MUST get 412!
        let late_put1_resp = audit_transport
            .send(S3RawRequest {
                method: Method::PUT,
                key: Some(part1_key.clone()),
                query: Vec::new(),
                headers: vec![("if-none-match".to_owned(), "*".to_owned())],
                body: Bytes::copy_from_slice(&secret_prep.s3_parts()[1].compressed),
            })
            .await
            .unwrap();
        assert_eq!(
            late_put1_resp.status, 412,
            "delayed data PUT after terminal marker MUST be fenced with 412"
        );

        // Verify both part0_key and part1_key hold permanent nonsecret terminal markers (zero secret bytes!),
        // and in Enabled mode the old data versionId on part0_key was permanently deleted!
        for k in [&part0_key, &part1_key] {
            let get_k = audit_transport
                .send(S3RawRequest {
                    method: Method::GET,
                    key: Some(k.clone()),
                    query: Vec::new(),
                    headers: Vec::new(),
                    body: Bytes::new(),
                })
                .await
                .unwrap();
            assert_eq!(get_k.status, 200);
            assert!(
                TerminalMarkerMeta::is_terminal_marker(&get_k.body),
                "retired S3 key '{k}' must permanently serve terminal marker"
            );
        }
        if expected_mode == S3BucketMode::Enabled
            && let Some(vid0) = &stale_part0_vid
        {
            let get_old_ver = audit_transport
                .send(S3RawRequest {
                    method: Method::GET,
                    key: Some(part0_key.clone()),
                    query: vec![("versionId".to_owned(), vid0.clone())],
                    headers: Vec::new(),
                    body: Bytes::new(),
                })
                .await
                .unwrap();
            assert_eq!(
                get_old_ver.status, 404,
                "retired data versionId on Enabled bucket must be deleted"
            );
        }

        // Now re-stage the EXACT SAME logical digest under epoch2!
        // It must get a brand-new publication_id + keys; stale marker PUT / exact DELETE on old keys cannot touch it!
        let restaged_ticket = store
            .stage_blob(&scope, epoch2, &secret_prep)
            .await
            .expect("re-stage same digest after retirement");
        assert_ne!(
            restaged_ticket.publication_id(),
            manual_pub_id,
            "new lifetime of same digest must never reuse retired publication_id"
        );
        store
            .commit_blob_reference_claim(
                &scope,
                epoch2,
                BlobReferenceClaim {
                    owner_kind: BlobOwnerKind::NoteRevision,
                    owner_id: NoteId::from_bytes([45; 16]).to_string(),
                    owner_rev_id: "rev_fresh_1".to_owned(),
                    resource_key: "carrier".to_owned(),
                    ticket: restaged_ticket,
                },
                None,
                None,
            )
            .await
            .unwrap();

        // Simulate stale old cleanup replaying marker PUT + exact-version DELETE on old `part0_key`:
        if expected_mode == S3BucketMode::Enabled
            && let Some(vid0) = &stale_part0_vid
        {
            let _ = audit_transport
                .send(S3RawRequest {
                    method: Method::DELETE,
                    key: Some(part0_key.clone()),
                    query: vec![("versionId".to_owned(), vid0.clone())],
                    headers: Vec::new(),
                    body: Bytes::new(),
                })
                .await
                .unwrap();
        }
        // New live publication remains 100% intact!
        assert_eq!(
            store
                .read_verified_blob(&scope, secret_prep.digest())
                .await
                .unwrap(),
            secret_payload
        );

        // Runtime mode drift check: suspending a live Enabled bucket during serving MUST fail closed!
        if expected_mode == S3BucketMode::Enabled {
            admin_set_bucket_versioning(&s3_cfg, "Suspended")
                .await
                .unwrap();
            let drift_prep = store.prepare_blob(b"post-drift write").unwrap();
            let drift_res = store.stage_blob(&scope, epoch2, &drift_prep).await;
            assert_validation_err(&drift_res, ValidationReason::InvalidState);
        }

        // Audit transport invariants: ZERO multipart/CopyObject, ZERO unconditional data PUTs,
        // and in Enabled mode ZERO unversioned CAS deletes!
        assert_eq!(
            audit_transport
                .multipart_or_copy_calls
                .load(Ordering::SeqCst),
            0,
            "S3 CAS must make zero multipart or CopyObject calls"
        );
        assert_eq!(
            audit_transport
                .unconditional_data_puts
                .load(Ordering::SeqCst),
            0,
            "every S3 CAS data PUT must carry If-None-Match: *"
        );
        if expected_mode == S3BucketMode::Enabled {
            assert_eq!(
                audit_transport
                    .unversioned_cas_deletes
                    .load(Ordering::SeqCst),
                0,
                "Enabled bucket retirement must never issue unversioned DeleteObject on CAS keys"
            );
        }

        if expected_mode == S3BucketMode::NeverVersioned {
            let zero = store
                .release_blob_owner_references(
                    &scope,
                    epoch2,
                    BlobOwnerKind::NoteRevision,
                    NoteId::from_bytes([44; 16]).as_str(),
                )
                .await
                .unwrap();
            assert_eq!(zero, vec![lost_prep.digest()]);
            *audit_transport.versioning_on_next_marker.lock().unwrap() = Some(s3_cfg.clone());
            assert!(
                store
                    .retire_zero_ref_digests(&scope, epoch2, &zero, RetirementReason::Gc, None)
                    .await
                    .is_err()
            );
            assert_eq!(
                store
                    .execute_diagnostic_read_sql_for_test(
                        None,
                        "SELECT COUNT(*) FROM blob_retirements WHERE status = 'pending'"
                    )
                    .await
                    .unwrap(),
                1
            );
            drop(store);
            rt.shutdown().await.unwrap();
            let (reopened, runtime) =
                CanonicalRuntime::open_with_s3_transport(cfg, Some(audit_transport.clone()))
                    .await
                    .unwrap();
            reopened
                .advance_space_lease(
                    &maintenance_ctx(ServicePurpose::Revocation),
                    &scope,
                    epoch2.checked_next().unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                reopened
                    .execute_diagnostic_read_sql_for_test(
                        None,
                        "SELECT COUNT(*) FROM blob_retirements WHERE status = 'pending'"
                    )
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                audit_transport
                    .unversioned_cas_deletes
                    .load(Ordering::SeqCst),
                0
            );
            runtime.shutdown().await.unwrap();
        } else {
            drop(store);
            rt.shutdown().await.unwrap();
        }
        fixtures.drop_pg_schema(&pg_schema).await;
    }
}
