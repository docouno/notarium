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
                        tool_calls: Vec::new(),
                        provenance: None,
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
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
                    tool_calls: Vec::new(),
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
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
    claim_run(
        &store,
        owner_ctx(&scope, actor.clone()),
        ChatAudience::Personal,
        &thread,
        &sample_run_id(0xdf),
        ThreadEntrySeq::ZERO,
    )
    .await;
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

#[tokio::test]
async fn lease_turnover_respects_budget_and_recovers_beyond_a_local_pin() {
    use notarium_canonical::blobs::BlobOwnerKind;
    use notarium_core::error::CommitEffect;
    let fixtures = StorageTestFixtures::load_required();
    let old = LeaseEpoch::new(1).unwrap();
    let next = LeaseEpoch::new(2).unwrap();
    for pg in [false, true] {
        let root = TempDataRoot::new("lease-interruption");
        let schema = fixtures.fresh_pg_schema();
        let cfg = if pg {
            fixtures.pg_local_config(sample_installation_id(0xe2), &schema, root.data_root())
        } else {
            CanonicalConfig::local_default(sample_installation_id(0xe2), root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
        for cancel in [false, true] {
            let (scope, actor, _) = create_thread(&store, if cancel { 0xe3 } else { 0xe4 }).await;
            let mut ctx = support::maintenance_ctx(ServicePurpose::Revocation);
            if cancel {
                ctx.budget.cancellation.cancel();
            } else {
                ctx.budget.remaining = Duration::ZERO;
            }
            let rejected = store.advance_space_lease(&ctx, &scope, next).await;
            assert!(
                matches!(rejected, Err(PortError::Cancelled(e) | PortError::DeadlineExceeded(e)) if e.effect()==CommitEffect::NotCommitted)
            );
            assert_eq!(
                store
                    .read_space(&scope.space_id)
                    .await
                    .unwrap()
                    .active_epoch,
                old
            );

            // A safe point keeps a live request waiting before it can update the epoch.
            let mut backup = store
                .prepare(
                    support::maintenance_ctx(ServicePurpose::Backup),
                    BackupId::from_bytes(random_bytes_16()),
                    store.default_backup_budget(),
                )
                .await
                .unwrap();
            let hold = backup.acquire_hold().await.unwrap();
            let pause = backup.pause_writes().await.unwrap();
            let mut waiting = support::maintenance_ctx(ServicePurpose::Revocation);
            waiting.budget.remaining = Duration::from_millis(50);
            assert!(
                matches!(store.advance_space_lease(&waiting, &scope, next).await,
                Err(PortError::DeadlineExceeded(e)) if e.effect()==CommitEffect::NotCommitted)
            );
            pause.resume().await.unwrap();
            hold.release().await.unwrap();
            assert_eq!(
                store
                    .read_space(&scope.space_id)
                    .await
                    .unwrap()
                    .active_epoch,
                old
            );

            let text = "an unowned local publication held by a live staging ticket ".repeat(20);
            let prepared = store.prepare_blob(text.as_bytes()).unwrap();
            store
                .stage_chat_blob(owner_ctx(&scope, actor.clone()), &text)
                .await
                .unwrap();
            let pin = store.stage_blob(&scope, old, &prepared).await.unwrap();
            let released = store
                .release_blob_owner_references(
                    &scope,
                    old,
                    BlobOwnerKind::StagedChat,
                    actor.as_str(),
                )
                .await
                .unwrap();
            assert_eq!(released, vec![prepared.digest()]);
            let mut ctx = support::maintenance_ctx(ServicePurpose::Revocation);
            ctx.budget.remaining = if cancel {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(500)
            };
            let token = ctx.budget.cancellation.clone();
            let active = store.clone();
            let target = scope.clone();
            let task =
                tokio::spawn(async move { active.advance_space_lease(&ctx, &target, next).await });
            tokio::time::timeout(Duration::from_secs(2), async {
                while pending(&store).await == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if cancel {
                token.cancel();
            }
            let granted = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(granted, next);
            assert_eq!(
                store
                    .read_space(&scope.space_id)
                    .await
                    .unwrap()
                    .active_epoch,
                next
            );
            assert!(
                root.data_root()
                    .blob(&scope.space_id, prepared.digest())
                    .is_file()
            );
            drop(pin);
            wait_for_cleanup(&store).await;
            assert!(
                !root
                    .data_root()
                    .blob(&scope.space_id, prepared.digest())
                    .exists()
            );
            assert_validation_err(
                &store.stage_blob(&scope, old, &prepared).await,
                ValidationReason::InvalidAuthority,
            );
            assert_eq!(
                store
                    .advance_space_lease(
                        &support::maintenance_ctx(ServicePurpose::Revocation),
                        &scope,
                        next
                    )
                    .await
                    .unwrap(),
                next
            );
        }
        runtime.shutdown().await.unwrap();
        if pg {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}

#[tokio::test]
async fn postgres_inflight_lease_commit_keeps_its_grant_with_the_initiator() {
    use notarium_core::error::{CommitEffect, RetryAdvice};
    use sqlx::Connection;
    let fixtures = StorageTestFixtures::load_required();
    let first = TempDataRoot::new("lease-ack-old");
    let second = TempDataRoot::new("lease-ack-new");
    let schema = fixtures.fresh_pg_schema();
    let install = sample_installation_id(0xe5);
    let (old, old_runtime) = CanonicalRuntime::open(fixtures.pg_local_config(
        install.clone(),
        &schema,
        first.data_root(),
    ))
    .await
    .unwrap();
    let (scope, _, _) = create_thread(&old, 0xe5).await;
    let (owner, runtime) =
        CanonicalRuntime::open(fixtures.pg_local_config(install, &schema, second.data_root()))
            .await
            .unwrap();
    let mut admin = fixtures.open_raw_pg().await;
    let mut probe = fixtures.open_raw_pg().await;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut admin)
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE FUNCTION {schema}.hold_lease_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('{schema}',8509)); RETURN NEW; END; $$; CREATE CONSTRAINT TRIGGER lease_commit AFTER UPDATE ON {schema}.spaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {schema}.hold_lease_commit()")))
        .execute(&mut probe).await.unwrap();
    let next = LeaseEpoch::new(2).unwrap();
    for in_commit in [false, true] {
        let mut barrier = admin.begin().await.unwrap();
        if in_commit {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,8509))")
                .bind(&schema)
                .execute(&mut *barrier)
                .await
                .unwrap();
        } else {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT space_id FROM {schema}.spaces FOR UPDATE"
            )))
            .execute(&mut *barrier)
            .await
            .unwrap();
        }
        let ctx = support::maintenance_ctx(ServicePurpose::Revocation);
        let cancel = ctx.budget.cancellation.clone();
        let running = owner.advance_space_lease(&ctx, &scope, next);
        tokio::pin!(running);
        let blocked = async {
            loop {
                let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))").bind(pid).fetch_one(&mut probe).await.unwrap();
                if waiting {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        };
        tokio::select! {r = &mut running => panic!("expected blocked lease: {r:?}"), ()=blocked=>{} }
        cancel.cancel();
        let expected = if in_commit {
            CommitEffect::Unknown
        } else {
            CommitEffect::NotCommitted
        };
        assert!(
            matches!(tokio::time::timeout(Duration::from_secs(1), &mut running).await.unwrap(), Err(PortError::Cancelled(e)) if e.effect()==expected && e.retry()==RetryAdvice::RetrySameCommand)
        );
        if !in_commit {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let blocked: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))").bind(pid).fetch_one(&mut probe).await.unwrap();
                    if !blocked { break; }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            }).await.expect("cancelled lease must release its database session while the row stays locked");
        }
        barrier.rollback().await.unwrap();
        if !in_commit {
            assert_eq!(
                old.read_space(&scope.space_id).await.unwrap().active_epoch,
                LeaseEpoch::new(1).unwrap()
            );
        }
    }
    // A new takeover request could mask a rolled-back first attempt. Observe
    // its SQL effect, then use the original initiator's grant for a normal write.
    let prepared = owner.prepare_blob(b"owner after a delayed commit").unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while old.read_space(&scope.space_id).await.unwrap().active_epoch != next {
            tokio::task::yield_now().await;
        }
        loop {
            match owner.stage_blob(&scope, next, &prepared).await {
                Ok(_) => break,
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::InvalidAuthority =>
                {
                    tokio::task::yield_now().await
                }
                Err(e) => panic!("unexpected staging failure: {e:?}"),
            }
        }
    })
    .await
    .expect("the initiating runtime publishes the actual COMMIT acknowledgement");
    let ctx = support::maintenance_ctx(ServicePurpose::Revocation);
    assert_eq!(
        owner.advance_space_lease(&ctx, &scope, next).await.unwrap(),
        next
    );
    assert_validation_err(
        &old.advance_space_lease(&ctx, &scope, next).await,
        ValidationReason::InvalidState,
    );
    runtime.shutdown().await.unwrap();
    old_runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn lease_reports_permanent_recovery_failure_after_grant() {
    use notarium_core::error::{CommitEffect, RetryAdvice};
    let fixtures = StorageTestFixtures::load_required();
    for pg in [false, true] {
        let root = TempDataRoot::new("lease-recovery-outcome");
        let schema = fixtures.fresh_pg_schema();
        let install = sample_installation_id(0xe7);
        let cfg = if pg {
            fixtures.pg_local_config(install, &schema, root.data_root())
        } else {
            CanonicalConfig::local_default(install, root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
        let (scope, _, _) = create_thread(&store, 0xe7).await;
        let next = LeaseEpoch::new(2).unwrap();
        let mut ctx = support::maintenance_ctx(ServicePurpose::Revocation);
        ctx.budget.remaining = Duration::from_secs(10);
        // A missing required table is reported as Internal/Never by the
        // recovery scanner. The Space epoch update can still commit normally.
        if pg {
            let mut admin = fixtures.open_raw_pg().await;
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "ALTER TABLE {schema}.pending_purges RENAME TO hidden_purges"
            )))
            .execute(&mut admin)
            .await
            .unwrap();
        } else {
            sqlx::query("ALTER TABLE pending_purges RENAME TO hidden_purges")
                .execute(&mut root.open_raw_sqlite().await)
                .await
                .unwrap();
        }
        let outcome = tokio::time::timeout(
            Duration::from_secs(3),
            store.advance_space_lease(&ctx, &scope, next),
        )
        .await
        .expect("permanent recovery failure must return before the caller budget expires");
        assert!(
            matches!(outcome, Err(PortError::Internal(e)) if e.effect() == CommitEffect::Unknown && e.retry() == RetryAdvice::Never)
        );
        assert_eq!(
            store
                .read_space(&scope.space_id)
                .await
                .unwrap()
                .active_epoch,
            next
        );
        if pg {
            let mut admin = fixtures.open_raw_pg().await;
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "ALTER TABLE {schema}.hidden_purges RENAME TO pending_purges"
            )))
            .execute(&mut admin)
            .await
            .unwrap();
        } else {
            sqlx::query("ALTER TABLE hidden_purges RENAME TO pending_purges")
                .execute(&mut root.open_raw_sqlite().await)
                .await
                .unwrap();
        }
        assert_eq!(
            store.advance_space_lease(&ctx, &scope, next).await.unwrap(),
            next
        );
        runtime.shutdown().await.unwrap();
        if pg {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}

async fn set_target_versions(
    fixtures: &StorageTestFixtures,
    root: &TempDataRoot,
    schema: Option<&str>,
    spaces: &[(ChangeCursor, std::path::PathBuf)],
    value: Option<&str>,
) {
    const UPDATE: &str =
        "UPDATE blob_retirement_targets SET data_version_ids_json = $1 WHERE space_id = $2";
    if let Some(schema) = schema {
        let mut conn = fixtures.open_raw_pg().await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET search_path TO {schema}")))
            .execute(&mut conn)
            .await
            .unwrap();
        for (cut, _) in spaces {
            let changed = sqlx::query(UPDATE)
                .bind(value)
                .bind(cut.scope.space_id.as_str())
                .execute(&mut conn)
                .await
                .unwrap();
            assert_eq!(changed.rows_affected(), 1);
        }
    } else {
        let mut conn = root.open_raw_sqlite().await;
        for (cut, _) in spaces {
            let changed = sqlx::query(UPDATE)
                .bind(value)
                .bind(cut.scope.space_id.as_str())
                .execute(&mut conn)
                .await
                .unwrap();
            assert_eq!(changed.rows_affected(), 1);
        }
    }
}

#[tokio::test]
async fn restored_retirements_release_terminal_workers_and_serve_other_spaces() {
    use notarium_canonical::blobs::BlobOwnerKind;
    use notarium_core::error::{CommitEffect, RetryAdvice};

    let fixtures = StorageTestFixtures::load_required();
    let old = LeaseEpoch::new(1).unwrap();
    let granted = LeaseEpoch::new(2).unwrap();
    for pg in [false, true] {
        let root = TempDataRoot::new("restored-terminal-retirements");
        let schema = fixtures.fresh_pg_schema();
        let installation = sample_installation_id(0xc7);
        let config = if pg {
            fixtures.pg_local_config(installation, &schema, root.data_root())
        } else {
            CanonicalConfig::local_default(installation, root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let mut spaces = Vec::new();
        for seed in 0xc0..=0xc8 {
            let (scope, actor, _) = create_thread(&store, seed).await;
            let text = format!("physical retirement for Space {seed} ").repeat(40);
            let digest = store.prepare_blob(text.as_bytes()).unwrap().digest();
            store
                .stage_chat_blob(owner_ctx(&scope, actor.clone()), &text)
                .await
                .unwrap();
            let released = store
                .release_blob_owner_references(
                    &scope,
                    old,
                    BlobOwnerKind::StagedChat,
                    actor.as_str(),
                )
                .await
                .unwrap();
            assert_eq!(released, vec![digest]);
            let path = root.data_root().blob(&scope.space_id, digest);
            assert!(path.is_file());
            let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
            let target = ChangeCursor {
                scope: HistoryScope {
                    space_id: scope.space_id,
                    incarnation: sample_incarnation(seed - 32),
                },
                after: head,
            };
            spaces.push((target, path));
        }
        // Restore schedules the sorted Spaces with four concurrent scanners.
        spaces.sort_by(|a, b| a.0.scope.space_id.cmp(&b.0.scope.space_id));
        let mut obstructions = Vec::new();
        for (cut, path) in &spaces[..8] {
            let digest = path.file_stem().unwrap().to_str().unwrap();
            let blocker = root
                .data_root()
                .root()
                .join("blobs/.quarantine")
                .join(format!("{}.{digest}.corrupt", cut.scope.space_id.as_str()));
            std::fs::create_dir_all(&blocker).unwrap();
            obstructions.push(blocker);
        }
        store
            .restore_cursors(
                support::maintenance_ctx(ServicePurpose::Restore),
                spaces.iter().map(|(cut, _)| cut.clone()).collect(),
            )
            .await
            .unwrap();

        // Eight blocked physical objects must release the restore scan slots.
        // The ninth Space completes with every obstruction still in place.
        tokio::time::timeout(Duration::from_secs(10), async {
            while spaces.iter().any(|(_, path)| path.exists())
                || store.active_retirement_workers_for_test() != 8
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("healthy Space must progress past all eight blocked Spaces");
        assert_eq!(pending(&store).await, 8);

        // Corrupt durable metadata for four IDs. Their physical workers must
        // stop. The other four remain eligible for automatic recovery.
        set_target_versions(
            &fixtures,
            &root,
            pg.then_some(schema.as_str()),
            &spaces[4..8],
            Some("invalid"),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(10), async {
            while store.active_retirement_workers_for_test() != 4 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("terminal metadata failure must release each worker");
        for blocker in obstructions {
            std::fs::remove_dir(blocker).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(15), async {
            while !store.storage_cleanup_idle_for_test() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("all automatic work must finish after repairing the filesystem");
        assert!(spaces[..4].iter().all(|(_, path)| !path.exists()));
        assert!(spaces[4..8].iter().all(|(_, path)| !path.exists()));
        assert_eq!(store.active_retirement_workers_for_test(), 0);
        assert_eq!(pending(&store).await, 4);
        for (cut, _) in &spaces {
            let observed = store.read_space(&cut.scope.space_id).await.unwrap();
            assert_eq!(observed.scope, cut.scope);
            assert_eq!(observed.active_epoch, granted);
        }

        let ctx = support::maintenance_ctx(ServicePurpose::Revocation);
        let outcome = store
            .advance_space_lease(&ctx, &spaces[4].0.scope, granted)
            .await;
        assert!(
            matches!(outcome, Err(PortError::Internal(e)) if e.effect()==CommitEffect::Unknown && e.retry()==RetryAdvice::Never)
        );
        assert_eq!(store.active_retirement_workers_for_test(), 0);
        assert_eq!(pending(&store).await, 4);
        set_target_versions(
            &fixtures,
            &root,
            pg.then_some(schema.as_str()),
            &spaces[4..8],
            None,
        )
        .await;
        for (cut, path) in &spaces[4..8] {
            assert_eq!(
                store
                    .advance_space_lease(&ctx, &cut.scope, granted)
                    .await
                    .unwrap(),
                granted
            );
            assert!(!path.exists());
        }
        assert_eq!(pending(&store).await, 0);
        runtime.shutdown().await.unwrap();
        if pg {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}

async fn seed_startup_retirement(config: &CanonicalConfig) -> (HistoryScope, ContentDigest) {
    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let (scope, actor, _) = create_thread(&store, 0xe9).await;
    let body = "last owner released before restart ".repeat(24);
    let staged = store
        .stage_chat_blob(owner_ctx(&scope, actor.clone()), &body)
        .await
        .unwrap();
    let digest = staged.digest();
    let released = store
        .release_blob_owner_references(
            &scope,
            LeaseEpoch::new(1).unwrap(),
            notarium_canonical::blobs::BlobOwnerKind::StagedChat,
            actor.as_str(),
        )
        .await
        .unwrap();
    assert_eq!(released, vec![digest]);
    runtime.shutdown().await.unwrap();
    (scope, digest)
}

#[tokio::test]
async fn sqlite_startup_releases_ownership_after_recovery_failure() {
    let tmp = TempDataRoot::new("startup-recovery-failure");
    let root = tmp.data_root();
    let cfg = CanonicalConfig::local_default(sample_installation_id(0xe9), root.clone());
    let (scope, digest) = seed_startup_retirement(&cfg).await;
    let object = root.blob(&scope.space_id, digest);
    assert!(object.is_file());
    let blocker = root.root().join("blobs/.quarantine").join(format!(
        "{}.{}.corrupt",
        scope.space_id.as_str(),
        digest.to_hex()
    ));
    std::fs::create_dir_all(&blocker).unwrap();

    let error = tokio::time::timeout(Duration::from_secs(5), CanonicalRuntime::open(cfg.clone()))
        .await
        .expect("startup reports the first attempt")
        .unwrap_err();
    assert!(
        matches!(error, PortError::Unavailable(failure) if failure.retry() == notarium_core::error::RetryAdvice::After(Duration::from_millis(250)))
    );
    let owner = notarium_canonical::DataRootOwnerLock::acquire(&root)
        .expect("failed opener released ownership");
    assert!(!object.exists());
    assert!(blocker.is_dir());
    drop(owner);

    std::fs::remove_dir(blocker).unwrap();
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    assert_eq!(pending(&store).await, 0);
    runtime.shutdown().await.unwrap();
}

#[derive(Debug)]
struct StalledStartupMarker {
    origin: ReqwestS3Transport,
    started: tokio::sync::Notify,
    active: tokio::sync::Semaphore,
}

impl S3Transport for StalledStartupMarker {
    fn send<'a>(&'a self, request: S3RawRequest) -> PortFuture<'a, S3RawResponse> {
        if request.method == http::Method::PUT
            && TerminalMarkerMeta::is_terminal_marker(&request.body)
        {
            return Box::pin(async move {
                let _active = self.active.acquire().await.unwrap();
                self.started.notify_one();
                std::future::pending().await
            });
        }
        self.origin.send(request)
    }
}

#[tokio::test]
async fn detached_sqlite_startup_retires_an_interrupted_current_epoch_upload() {
    let fixtures = StorageTestFixtures::load_required();
    let root = TempDataRoot::new("detached-startup-discard");
    let mut config = CanonicalConfig::local_default(sample_installation_id(0xea), root.data_root());
    let bucket = fixtures.fresh_s3_bucket("detached-discard");
    let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let audit = Arc::new(QueueS3Audit::new(&s3));
    config.blobs = notarium_canonical::BlobBackendConfig::S3(Box::new(s3));
    let (store, runtime) =
        CanonicalRuntime::open_with_s3_transport(config.clone(), Some(audit.clone()))
            .await
            .unwrap();
    let (scope, actor, thread) = create_thread(&store, 0xea).await;
    let ctx = owner_ctx(&scope, actor.clone());
    let note = sample_note_id(0xea);
    store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &actor,
                CreateNote {
                    folder_page: false,
                    note: note.clone(),
                    parent: None,
                    slug: "pending-purge".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Pending purge".into(),
                },
            ),
        )
        .await
        .unwrap();
    let run = sample_run_id(0xea);
    claim_run(
        &store,
        ctx.clone(),
        ChatAudience::Personal,
        &thread,
        &run,
        ThreadEntrySeq::ZERO,
    )
    .await;
    let body = "current-epoch private queue upload ".repeat(32);
    let prepared = store.prepare_blob(body.as_bytes()).unwrap();
    let (reached, uploaded) = tokio::sync::oneshot::channel();
    let (release, resume) = tokio::sync::oneshot::channel();
    *audit.takeover.lock().unwrap() = Some(PausedQueuePut {
        hash: blake3::hash(&prepared.s3_parts()[0].compressed),
        uploaded: true,
        reached,
        resume,
    });
    let mut upload = store.queue_chat_input(
        ctx.clone(),
        next_mutation(
            &scope,
            &actor,
            PendingChatInput {
                id: PendingInputId::from_bytes([0xea; 16]),
                thread,
                sender: actor.clone(),
                body,
                queued_base_leaf: ThreadEntrySeq::ZERO,
                in_flight_run: run,
                mentions_agent: false,
            },
        ),
    );
    let (key, version) = tokio::select! {
        result = &mut upload => panic!("expected PUT to be held before interning the upload: {result:?}"),
        observed = tokio::time::timeout(Duration::from_secs(10), uploaded) => observed.unwrap().unwrap(),
    };
    let version = version.expect("versioned PUT");
    drop(
        store
            .prepare_projection_visibility_cleanup(
                &support::maintenance_ctx(ServicePurpose::Projection),
                "eaeaeaeaeaeaeaeaeaeaeaeaeaeaeaea",
            )
            .await
            .unwrap(),
    );
    store
        .delete_note(
            ctx,
            next_mutation(
                &scope,
                &actor,
                DeleteNote {
                    note,
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap_err();
    const PENDING_PURGE: &str = "SELECT COUNT(*) FROM pending_purges WHERE phase='sql_erased'";
    assert_eq!(
        store
            .execute_diagnostic_read_sql_for_test(None, PENDING_PURGE)
            .await
            .unwrap(),
        1
    );

    let epoch = LeaseEpoch::new(1).unwrap();
    store
        .advance_space_lease(
            &support::maintenance_ctx(ServicePurpose::Revocation),
            &scope,
            epoch,
        )
        .await
        .unwrap();
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
        audit
            .origin
            .send(get(Some(version.clone())))
            .await
            .unwrap()
            .body
            .as_ref(),
        prepared.s3_parts()[0].compressed.as_ref()
    );
    // Drop the interrupted caller after shutdown has stopped its retirement workers.
    // The new owner must recover the durable discard.
    runtime.shutdown().await.unwrap();
    drop(upload);
    assert!(release.send(()).is_err());
    drop(store);

    let (reopened, runtime) = CanonicalRuntime::open(config).await.unwrap();
    assert_eq!(
        reopened
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .active_epoch,
        epoch
    );
    assert_eq!(
        reopened
            .execute_diagnostic_read_sql_for_test(None, PENDING_PURGE)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        audit.origin.send(get(Some(version))).await.unwrap().status,
        404
    );
    let latest = audit.origin.send(get(None)).await.unwrap();
    assert_eq!(latest.status, 200);
    assert!(TerminalMarkerMeta::is_terminal_marker(&latest.body));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_startup_cancels_unpublished_work_when_open_is_dropped() {
    let fixtures = StorageTestFixtures::load_required();
    let tmp = TempDataRoot::new("drop-startup");
    let root = tmp.data_root();
    let mut cfg = CanonicalConfig::local_default(sample_installation_id(0xe9), root.clone());
    let bucket = fixtures.fresh_s3_bucket("drop-startup");
    let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, None).await.unwrap();
    let transport = Arc::new(StalledStartupMarker {
        origin: ReqwestS3Transport::new(&s3).unwrap(),
        started: tokio::sync::Notify::new(),
        active: tokio::sync::Semaphore::new(1),
    });
    cfg.blobs = notarium_canonical::BlobBackendConfig::S3(Box::new(s3));
    seed_startup_retirement(&cfg).await;
    let mut opening = Box::pin(CanonicalRuntime::open_with_s3_transport(
        cfg.clone(),
        Some(transport.clone()),
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            result = &mut opening => panic!("open returned before interrupted marker: {result:?}"),
            () = transport.started.notified() => {}
        }
    })
    .await
    .expect("startup reaches durable retirement");
    assert!(notarium_canonical::DataRootOwnerLock::acquire(&root).is_err());
    assert_eq!(transport.active.available_permits(), 0);
    drop(opening);

    let owner = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(lock) = notarium_canonical::DataRootOwnerLock::acquire(&root) {
                break lock;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled opening releases ownership while the marker is stalled");
    assert_eq!(transport.active.available_permits(), 1);
    drop(owner);
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    assert_eq!(pending(&store).await, 0);
    runtime.shutdown().await.unwrap();
}
