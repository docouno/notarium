use super::*;
use notarium_core::{
    ids::BackupId,
    ports::{BackupHold, BackupParticipantPort, PreparedBackup, ServicePurpose},
};

async fn create_thread(
    store: &CanonicalStore,
    seed: u8,
) -> (HistoryScope, PrincipalId, ChatThreadId) {
    let actor = sample_principal_id(seed);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed),
            incarnation: sample_incarnation(seed),
            root_folder_id: sample_folder_id(seed),
            slug: format!("retire-{seed}"),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let thread = sample_thread_id(seed);
    store
        .create_chat(
            owner_ctx(&scope, actor.clone()),
            next_mutation(
                &scope,
                &actor,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Retained body".into(),
                },
            ),
        )
        .await
        .unwrap();
    (scope, actor, thread)
}

async fn pending(store: &CanonicalStore) -> i64 {
    store
        .execute_diagnostic_read_sql_for_test(
            None,
            "SELECT COUNT(*) FROM blob_retirements WHERE status='pending'",
        )
        .await
        .unwrap()
}

async fn wait_for_cleanup(store: &CanonicalStore) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while pending(store).await != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

struct HeldRedaction {
    scope: HistoryScope,
    text: String,
    _source: Box<dyn PreparedBackup>,
    hold: Box<dyn BackupHold>,
}

async fn held_redactions(
    store: &CanonicalStore,
    physical: &QueuePhysical<'_>,
    seed: u8,
) -> HeldRedaction {
    let (scope, actor, thread) = create_thread(store, seed).await;
    let ctx = owner_ctx(&scope, actor.clone());
    let text = format!("body {seed} ").repeat(85);
    let digest = store.prepare_blob(text.as_bytes()).unwrap().digest();
    let mut leaves = vec![ThreadEntrySeq::ZERO];
    for _ in 0..2 {
        let staged = store.stage_chat_blob(ctx.clone(), &text).await.unwrap();
        let next = store
            .append_chat(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    AppendChat {
                        thread: thread.clone(),
                        parent: *leaves.last().unwrap(),
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Staged(staged),
                        referenced_notes: vec![],
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap()
            .value
            .seq;
        leaves.push(next);
    }
    let mut backup = store
        .prepare(
            support::maintenance_ctx(ServicePurpose::Backup),
            BackupId::from_bytes([seed; 16]),
            store.default_backup_budget(),
        )
        .await
        .unwrap();
    let hold = backup.acquire_hold().await.unwrap();
    for entry in [leaves[1], leaves[2]] {
        let head = store
            .read_chat(
                ctx.clone(),
                ChatRead {
                    thread: thread.clone(),
                    leaf: leaves[2],
                    before: None,
                    max_entries: PageLimit::new(1).unwrap(),
                },
            )
            .await
            .unwrap()
            .thread;
        let request = next_mutation(
            &scope,
            &actor,
            RedactChatEntry {
                thread: thread.clone(),
                entry,
                expected_thread_revision: head.revision,
            },
        );
        let committed = store
            .redact_chat_entry(ctx.clone(), request.clone())
            .await
            .unwrap();
        if entry == leaves[2] {
            // Retry the command and the same granted epoch while physical work is held.
            for _ in 0..4 {
                let replay = store
                    .redact_chat_entry(ctx.clone(), request.clone())
                    .await
                    .unwrap();
                assert_eq!(replay.receipt, committed.receipt);
                store
                    .advance_space_lease(
                        &support::maintenance_ctx(ServicePurpose::Revocation),
                        &scope,
                        LeaseEpoch::new(1).unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(store.active_retirement_workers_for_test(), 1);
            }
        }
        if entry == leaves[1] {
            assert_eq!(
                store.read_verified_blob(&scope, digest).await.unwrap(),
                text.as_bytes()
            );
            assert_eq!(pending(store).await, 0);
        }
    }
    assert!(matches!(
        store.read_verified_blob(&scope, digest).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert_eq!(pending(store).await, 1);
    match physical {
        QueuePhysical::Local(root) => assert!(root.blob(&scope.space_id, digest).is_file()),
        QueuePhysical::S3(audit) => {
            let prep = store.prepare_blob(text.as_bytes()).unwrap();
            let hash = blake3::hash(&prep.s3_parts()[0].compressed);
            let key = audit
                .puts
                .lock()
                .unwrap()
                .iter()
                .find(|(h, _)| *h == hash)
                .unwrap()
                .1
                .clone();
            let actual = audit
                .origin
                .send(S3RawRequest {
                    method: http::Method::GET,
                    key: Some(key),
                    query: vec![],
                    headers: vec![],
                    body: bytes::Bytes::new(),
                })
                .await
                .unwrap();
            assert_eq!(actual.status, 200);
            assert_eq!(actual.body.as_ref(), prep.s3_parts()[0].compressed.as_ref());
        }
    }
    HeldRedaction {
        scope,
        text,
        _source: backup,
        hold,
    }
}

#[tokio::test]
async fn redaction_with_backup_hold_preserves_shared_owners_and_reclaims_after_release_or_restart()
{
    let fixtures = StorageTestFixtures::load_required();
    for cloud in [false, true] {
        let root = TempDataRoot::new("held-redaction");
        let schema = fixtures.fresh_pg_schema();
        let (cfg, audit) = if cloud {
            let name = fixtures.fresh_s3_bucket("held-redaction");
            let s3 = fixtures.s3_config(&name, S3BucketModePolicy::DetectFromBucket);
            admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
            let audit = Arc::new(QueueS3Audit::new(&s3));
            (
                fixtures.pg_s3_config(sample_installation_id(0xd9), &schema, s3),
                Some(audit),
            )
        } else {
            (
                CanonicalConfig::local_default(sample_installation_id(0xd8), root.data_root()),
                None,
            )
        };
        let transport = audit.clone().map(|v| v as Arc<dyn S3Transport>);
        let physical = match &audit {
            Some(a) => QueuePhysical::S3(a),
            None => QueuePhysical::Local(root.data_root()),
        };
        let (store, rt) = CanonicalRuntime::open_with_s3_transport(cfg.clone(), transport.clone())
            .await
            .unwrap();
        for explicit in [true, false] {
            let held = held_redactions(&store, &physical, if explicit { 0xd7 } else { 0xd8 }).await;
            if explicit {
                held.hold.release().await.unwrap();
            } else {
                drop(held.hold);
            }
            wait_for_cleanup(&store).await;
            physical
                .assert_discarded(&store, &held.scope, &held.text, false)
                .await;
        }
        // Previous releases could persist a zero-owner active digest without a retirement.
        let (legacy, actor, _) = create_thread(&store, 0xda).await;
        let old_body = "retained before the last owner was released ".repeat(20);
        let saved = store
            .stage_chat_blob(owner_ctx(&legacy, actor.clone()), &old_body)
            .await
            .unwrap();
        let released = store
            .release_blob_owner_references(
                &legacy,
                LeaseEpoch::new(1).unwrap(),
                notarium_canonical::blobs::BlobOwnerKind::StagedChat,
                actor.as_str(),
            )
            .await
            .unwrap();
        assert_eq!(released, vec![saved.digest()]);
        assert!(matches!(
            store.read_verified_blob(&legacy, saved.digest()).await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        let HeldRedaction {
            scope,
            text,
            _source: backup,
            hold,
        } = held_redactions(&store, &physical, 0xd9).await;
        // Keep the physical pin until owner shutdown cancels its cleanup tasks.
        rt.shutdown().await.unwrap();
        drop(hold);
        drop(backup);
        drop(store);
        let (reopened, rt) = CanonicalRuntime::open_with_s3_transport(cfg, transport)
            .await
            .unwrap();
        if cloud {
            for target in [&scope, &legacy] {
                reopened
                    .advance_space_lease(
                        &support::maintenance_ctx(ServicePurpose::Revocation),
                        target,
                        LeaseEpoch::new(2).unwrap(),
                    )
                    .await
                    .unwrap();
            }
        }
        physical
            .assert_discarded(&reopened, &legacy, &old_body, false)
            .await;
        wait_for_cleanup(&reopened).await;
        physical
            .assert_discarded(&reopened, &scope, &text, false)
            .await;
        let digest = reopened.prepare_blob(text.as_bytes()).unwrap().digest();
        assert!(matches!(
            reopened.read_verified_blob(&scope, digest).await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        rt.shutdown().await.unwrap();
        if cloud {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}

#[tokio::test]
async fn committed_redaction_and_replay_return_while_local_stager_holds_bytes() {
    let root = TempDataRoot::new("redaction-live-stager");
    let cfg = CanonicalConfig::local_default(sample_installation_id(0xe1), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let (scope, actor, thread) = create_thread(&store, 0xe1).await;
    let ctx = owner_ctx(&scope, actor.clone());
    let text = "local stage keeps this digest pinned ".repeat(24);
    let prepared = store.prepare_blob(text.as_bytes()).unwrap();
    let staged = store.stage_chat_blob(ctx.clone(), &text).await.unwrap();
    let appended = store
        .append_chat(
            ctx.clone(),
            next_mutation(
                &scope,
                &actor,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Staged(staged),
                    referenced_notes: vec![],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    let read = ChatRead {
        thread: thread.clone(),
        leaf: appended.value.seq,
        before: None,
        max_entries: PageLimit::new(1).unwrap(),
    };
    let before = store.read_chat(ctx.clone(), read.clone()).await.unwrap();
    let pin = store
        .stage_blob(&scope, LeaseEpoch::new(1).unwrap(), &prepared)
        .await
        .unwrap();
    let request = next_mutation(
        &scope,
        &actor,
        RedactChatEntry {
            thread,
            entry: appended.value.seq,
            expected_thread_revision: before.thread.revision,
        },
    );
    let mut caller = ctx.clone();
    caller.budget.remaining = Duration::from_millis(500);
    let committed = tokio::time::timeout(
        caller.budget.remaining,
        store.redact_chat_entry(caller.clone(), request.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    let replay = tokio::time::timeout(
        caller.budget.remaining,
        store.redact_chat_entry(caller, request),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(committed.receipt, replay.receipt);
    assert_eq!(pending(&store).await, 1);
    assert_eq!(store.active_retirement_workers_for_test(), 1);
    assert!(
        root.data_root()
            .blob(&scope.space_id, prepared.digest())
            .is_file()
    );
    assert_eq!(
        store.read_chat(ctx, read).await.unwrap().entries[0].body,
        ChatBody::Redacted
    );
    drop(pin);
    wait_for_cleanup(&store).await;
    assert!(
        !root
            .data_root()
            .blob(&scope.space_id, prepared.digest())
            .exists()
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn retrying_owner_keeps_its_upload_and_cleans_a_dropped_caller_executor() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let name = fixtures.fresh_s3_bucket("owner-runtime");
    let s3 = fixtures.s3_config(&name, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let audit = Arc::new(QueueS3Audit::new(&s3));
    let cfg = fixtures.pg_s3_config(sample_installation_id(0xdf), &schema, s3);
    let (store, rt) = CanonicalRuntime::open_with_s3_transport(cfg, Some(audit.clone()))
        .await
        .unwrap();
    let (scope, actor, thread) = create_thread(&store, 0xdf).await;
    let epoch = LeaseEpoch::new(2).unwrap();
    store
        .advance_space_lease(
            &support::maintenance_ctx(ServicePurpose::Revocation),
            &scope,
            epoch,
        )
        .await
        .unwrap();
    for lose_caller in [false, true] {
        let text = format!("published by a short-lived executor {lose_caller} ").repeat(24);
        let prepared = store.prepare_blob(text.as_bytes()).unwrap();
        let (reached, put) = tokio::sync::oneshot::channel();
        let (release, resume) = tokio::sync::oneshot::channel();
        *audit.takeover.lock().unwrap() = Some(PausedQueuePut {
            hash: blake3::hash(&prepared.s3_parts()[0].compressed),
            uploaded: true,
            reached,
            resume,
        });
        let ctx = owner_ctx(&scope, actor.clone());
        let write = next_mutation(
            &scope,
            &actor,
            PendingChatInput {
                id: PendingInputId::from_bytes(random_bytes_16()),
                thread: thread.clone(),
                sender: actor.clone(),
                body: text.clone(),
                queued_base_leaf: ThreadEntrySeq::ZERO,
                in_flight_run: sample_run_id(0xdf),
                mentions_agent: false,
            },
        );
        let caller = store.clone();
        let (stop_tx, stop) = tokio::sync::oneshot::channel();
        let foreign = tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let write_task =
                    tokio::spawn(async move { caller.queue_chat_input(ctx, write).await });
                if lose_caller {
                    stop.await.unwrap();
                    None
                } else {
                    Some(write_task.await.unwrap().unwrap())
                }
            })
        });
        let (key, version) = tokio::time::timeout(Duration::from_secs(10), put)
            .await
            .unwrap()
            .unwrap();
        // Recovery of a previous turnover must leave current-epoch private keys owned by the uploader.
        store
            .advance_space_lease(
                &support::maintenance_ctx(ServicePurpose::Revocation),
                &scope,
                epoch,
            )
            .await
            .unwrap();
        assert_eq!(pending(&store).await, 1);
        let get = |version: Option<String>| S3RawRequest {
            method: http::Method::GET,
            key: Some(key.clone()),
            query: version
                .into_iter()
                .map(|v| ("versionId".into(), v))
                .collect(),
            headers: vec![],
            body: bytes::Bytes::new(),
        };
        assert_eq!(
            audit.origin.send(get(None)).await.unwrap().body.as_ref(),
            prepared.s3_parts()[0].compressed.as_ref()
        );
        if lose_caller {
            stop_tx.send(()).unwrap();
            assert!(foreign.await.unwrap().is_none());
            assert!(release.send(()).is_err());
            wait_for_cleanup(&store).await;
            assert_eq!(audit.origin.send(get(version)).await.unwrap().status, 404);
            assert!(TerminalMarkerMeta::is_terminal_marker(
                &audit.origin.send(get(None)).await.unwrap().body
            ));
            let mut b = store
                .prepare(
                    support::maintenance_ctx(ServicePurpose::Backup),
                    BackupId::from_bytes([0xdf; 16]),
                    store.default_backup_budget(),
                )
                .await
                .unwrap();
            b.acquire_hold().await.unwrap().release().await.unwrap();
        } else {
            release.send(()).unwrap();
            assert!(matches!(
                foreign.await.unwrap(),
                Some(QueueInputOutcome::Queued(_))
            ));
            assert_eq!(
                store
                    .read_verified_blob(&scope, prepared.digest())
                    .await
                    .unwrap(),
                text.as_bytes()
            );
        }
    }
    rt.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
