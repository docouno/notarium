use super::*;
use notarium_canonical::{AppendCollabUpdate, CreateFolderSpec};

#[tokio::test]
async fn materialize_child_first_folders_and_recover_an_active_room() {
    for case in [
        BackendCase::open_sqlite().await,
        BackendCase::open_pg_s3().await,
    ] {
        let store = &case.store;
        let space = store.create_space(backup_test_space(0xe0)).await.unwrap();
        let parent = sample_folder_id(0xb0);
        let child = sample_folder_id(0x10);
        for (id, under, slug) in [
            (parent.clone(), None, "parent"),
            (child.clone(), Some(parent.clone()), "child"),
        ] {
            store
                .create_folder(CreateFolderSpec {
                    scope: space.scope.clone(),
                    active_epoch: space.active_epoch,
                    folder_id: id,
                    parent: under,
                    slug: slug.to_owned(),
                    display_name: slug.to_owned(),
                    is_project: false,
                    project_slug: None,
                    actor: space.owner.clone(),
                    timestamp: None,
                })
                .await
                .unwrap();
        }
        let note = sample_note_id(0x81);
        let created = store
            .create_note(
                owner_ctx(&space.scope, space.owner.clone()),
                next_mutation(
                    &space.scope,
                    &space.owner,
                    CreateNote {
                        note: note.clone(),
                        parent: Some(child.clone()),
                        slug: "room".into(),
                        class: DocClass::UserDoc,
                        carrier: "---\ntitle: Room\n---\nRoom\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let old = store
            .open_collab_session(
                &make_budget(),
                OpenCollabSession {
                    scope: space.scope.clone(),
                    note: note.clone(),
                    owner_id: "source".into(),
                    expected_carrier_rev: created.value.revision.clone(),
                    expected_lease: None,
                    expected_lineage: None,
                    initial_yrs_snapshot: Some(vec![10, 11]),
                    allow_fenced_recovery: false,
                },
            )
            .await
            .unwrap();
        let delta = AppendCollabUpdate {
            scope: space.scope.clone(),
            note: note.clone(),
            owner_id: "source".into(),
            expected_lease: old.lease_epoch,
            expected_lineage: old.lineage_epoch,
            update_seq: 1,
            update_bytes: vec![12, 13],
        };
        store
            .append_collab_update(&make_budget(), delta.clone())
            .await
            .unwrap();
        let budget = store.default_backup_budget();
        let mut prepared = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes(random_bytes_16()),
                budget,
            )
            .await
            .unwrap();
        let hold = prepared.acquire_hold().await.unwrap();
        let mut pause = prepared.pause_writes().await.unwrap();
        let mut cut = pause.open_cut().await.unwrap();
        pause.resume().await.unwrap();
        let artifact = cut.spool(budget, Cancellation::default()).await.unwrap();
        cut.close().await.unwrap();
        let record = store.get_backup_artifact(&artifact.artifact).await.unwrap();
        if let Some((fixtures, _)) = &case.pg_cleanup {
            let mut invalid = decode_postgres_spool_v1(&record.artifact_path).unwrap();
            let folders = invalid
                .tables
                .iter_mut()
                .find(|table| table.name == "folder_heads")
                .unwrap();
            let id = folders
                .columns
                .iter()
                .position(|column| column == "folder_id")
                .unwrap();
            assert_eq!(
                folders.rows[0][id],
                PostgresSpoolValue::Text(child.as_str().to_owned())
            );
            folders.rows.retain(|row| !matches!(&row[id], PostgresSpoolValue::Text(value) if value == parent.as_str()));
            let schema = fixtures.fresh_pg_schema();
            let mut conn = fixtures.open_raw_pg().await;
            let mut tx = conn.begin().await.unwrap();
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema}"
            )))
            .execute(&mut *tx)
            .await
            .unwrap();
            sqlx::raw_sql(notarium_canonical::schema::POSTGRES_BASELINE_DDL)
                .execute(&mut *tx)
                .await
                .unwrap();
            assert!(
                invalid.import_rows(&mut tx).await.is_err(),
                "the final INSERT must enforce the parent FK"
            );
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM spaces")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(
                count, 0,
                "a failed import must roll back its earlier tables"
            );
            tx.rollback().await.unwrap();
        }
        let root = TempDataRoot::new("restore-active-child-first");
        let cfg = case
            .restored_config(&record.artifact_path, &root.data_root())
            .await;
        hold.release().await.unwrap();
        drop(prepared);
        let (target, runtime) = CanonicalRuntime::open(cfg.clone()).await.unwrap();
        let count = target.execute_diagnostic_read_sql_for_test(None, &format!(
            "SELECT count(*) FROM folder_heads WHERE folder_id='{}' AND parent_folder_id='{}'", child.as_str(), parent.as_str()
        )).await.unwrap();
        assert_eq!(count, 1);
        let scope = HistoryScope {
            space_id: space.scope.space_id.clone(),
            incarnation: sample_incarnation(0x92),
        };
        target
            .restore_cursors(
                maintenance_ctx(ServicePurpose::Restore),
                vec![ChangeCursor {
                    scope: scope.clone(),
                    after: artifact.witness.histories[0].after,
                }],
            )
            .await
            .unwrap();
        let recovered = target
            .read_collab_session(None, &scope, &note)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.session.room_state, CollabRoomState::Fenced);
        assert!(recovered.session.owner_id.is_none());
        assert_eq!(
            recovered.session.lease_epoch,
            old.lease_epoch.checked_next().unwrap()
        );
        assert_eq!(recovered.session.lineage_epoch, old.lineage_epoch);
        assert_eq!(recovered.session.yrs_snapshot_blob, old.yrs_snapshot_blob);
        assert_eq!(recovered.updates.len(), 1);
        assert_eq!(recovered.updates[0].lease_epoch, old.lease_epoch);
        assert_eq!(recovered.updates[0].update_bytes, delta.update_bytes);
        assert!(
            target
                .append_collab_update(
                    &make_budget(),
                    AppendCollabUpdate {
                        scope: scope.clone(),
                        update_seq: 2,
                        ..delta
                    }
                )
                .await
                .is_err()
        );
        let open = OpenCollabSession {
            scope: scope.clone(),
            note: note.clone(),
            owner_id: "restored".into(),
            expected_carrier_rev: created.value.revision,
            expected_lease: Some(recovered.session.lease_epoch),
            expected_lineage: Some(old.lineage_epoch),
            initial_yrs_snapshot: None,
            allow_fenced_recovery: true,
        };
        let active = target
            .open_collab_session(&make_budget(), open)
            .await
            .unwrap();
        assert_eq!(
            active.lease_epoch,
            recovered.session.lease_epoch.checked_next().unwrap()
        );
        assert_eq!(active.lineage_epoch, old.lineage_epoch);
        runtime.shutdown().await.unwrap();
        if let (Some((fixtures, _)), SqlBackendConfig::Postgres { schema, .. }) =
            (&case.pg_cleanup, &cfg.sql)
        {
            fixtures.drop_pg_schema(schema).await;
        }
        case.shutdown().await;
    }
}

#[tokio::test]
async fn restore_interruption_while_waiting_for_safe_point_preserves_history() {
    for case in [
        BackendCase::open_sqlite().await,
        BackendCase::open_pg_s3().await,
    ] {
        let store = &case.store;
        let space = store.create_space(backup_test_space(0x90)).await.unwrap();
        store
            .create_note(
                owner_ctx(&space.scope, space.owner.clone()),
                next_mutation(
                    &space.scope,
                    &space.owner,
                    CreateNote {
                        note: sample_note_id(0x90),
                        parent: None,
                        slug: "receipt".into(),
                        class: DocClass::UserDoc,
                        carrier: "---\ntitle: Receipt\n---\nReceipt\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let space = store.read_space(&space.scope.space_id).await.unwrap();
        let guard = store.acquire_writer_safe_point().await.unwrap();
        for mode in ["deadline", "cancel", "drop"] {
            let mut ctx = maintenance_ctx(ServicePurpose::Restore);
            let cancel = ctx.budget.cancellation.clone();
            if mode == "deadline" {
                ctx.budget.remaining = Duration::from_millis(80);
            }
            let target = ChangeCursor {
                scope: HistoryScope {
                    space_id: space.scope.space_id.clone(),
                    incarnation: sample_incarnation(0x91),
                },
                after: space.last_seq,
            };
            let mut request = store.restore_cursors(ctx, vec![target]);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut request)
                    .await
                    .is_err()
            );
            if mode == "drop" {
                drop(request);
                continue;
            }
            if mode == "cancel" {
                cancel.cancel();
            }
            let error = tokio::time::timeout(Duration::from_secs(1), request)
                .await
                .unwrap()
                .unwrap_err();
            match (mode, error) {
                ("deadline", PortError::DeadlineExceeded(f))
                | ("cancel", PortError::Cancelled(f)) => {
                    assert_eq!(f.effect(), CommitEffect::NotCommitted)
                }
                (_, e) => panic!("unexpected restore outcome: {e:?}"),
            }
        }
        drop(guard);
        if case.is_sqlite {
            let blocker =
                rusqlite::Connection::open(case.temp_root.data_root().canonical()).unwrap();
            blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
            let mut ctx = maintenance_ctx(ServicePurpose::Restore);
            ctx.budget.remaining = Duration::from_millis(80);
            let target = ChangeCursor {
                scope: HistoryScope {
                    space_id: space.scope.space_id.clone(),
                    incarnation: sample_incarnation(0x91),
                },
                after: space.last_seq,
            };
            let error = tokio::time::timeout(
                Duration::from_secs(1),
                store.restore_cursors(ctx, vec![target]),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert!(
                matches!(error, PortError::DeadlineExceeded(f) if f.effect() == CommitEffect::NotCommitted)
            );
            blocker.execute_batch("ROLLBACK").unwrap();
        }
        let drain = store.acquire_writer_safe_point().await.unwrap();
        drop(drain);
        assert_eq!(
            store.read_space(&space.scope.space_id).await.unwrap(),
            space
        );
        assert_eq!(
            store
                .execute_diagnostic_read_sql_for_test(None, "SELECT COUNT(*) FROM command_receipts")
                .await
                .unwrap(),
            1
        );
        case.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pg_restore_lock_and_commit_interruption_report_distinct_effects() {
    let case = BackendCase::open_pg_s3_with_pool(2).await;
    let (fixtures, schema) = case.pg_cleanup.as_ref().unwrap();
    let mut blocker = fixtures.open_raw_pg().await;
    let mut probe = fixtures.open_raw_pg().await;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut blocker)
        .await
        .unwrap();
    let store = &case.store;
    for (phase, byte) in [
        ("locked", 0x93),
        ("commit_cancel", 0x94),
        ("commit_drop", 0x95),
    ] {
        let in_commit = phase != "locked";
        let space = store.create_space(backup_test_space(byte)).await.unwrap();
        let target = ChangeCursor {
            scope: HistoryScope {
                space_id: space.scope.space_id.clone(),
                incarnation: sample_incarnation(0x96),
            },
            after: space.last_seq,
        };

        let mut barrier = blocker.begin().await.unwrap();
        if phase == "commit_cancel" {
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "CREATE FUNCTION {schema}.delay_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                   PERFORM pg_advisory_xact_lock(hashtextextended('{schema}',9029)); RETURN NEW; END; $$;
                 CREATE CONSTRAINT TRIGGER restore_ack AFTER UPDATE ON {schema}.spaces DEFERRABLE INITIALLY DEFERRED
                   FOR EACH ROW EXECUTE FUNCTION {schema}.delay_commit()"
            ))).execute(&mut probe).await.unwrap();
        }
        if in_commit {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,9029))")
                .bind(schema)
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
        let ctx = maintenance_ctx(ServicePurpose::Restore);
        let cancel = ctx.budget.cancellation.clone();
        let mut request = store.restore_cursors(ctx, vec![target.clone()]);
        let waiting = async {
            loop {
                let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))")
                    .bind(pid).fetch_one(&mut probe).await.unwrap();
                if blocked {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        };
        tokio::select! { result = &mut request => panic!("restore finished before lock: {result:?}"), result = tokio::time::timeout(Duration::from_secs(3), waiting) => result.unwrap() };
        if phase == "commit_drop" {
            drop(request);
        } else {
            cancel.cancel();
            let error = tokio::time::timeout(Duration::from_secs(3), request)
                .await
                .unwrap()
                .unwrap_err();
            let expected = if in_commit {
                CommitEffect::Unknown
            } else {
                CommitEffect::NotCommitted
            };
            assert!(matches!(error, PortError::Cancelled(f) if f.effect() == expected));
        }
        assert_eq!(
            store.read_space(&space.scope.space_id).await.unwrap(),
            space
        );
        barrier.rollback().await.unwrap();
        let drain = store.acquire_writer_safe_point().await.unwrap();
        drop(drain);
        if in_commit {
            let rebound = store.read_space(&space.scope.space_id).await.unwrap();
            assert_eq!(rebound.scope, target.scope);
            assert_eq!(
                rebound.active_epoch,
                space.active_epoch.checked_next().unwrap()
            );
            store
                .create_note(
                    owner_ctx(&target.scope, space.owner.clone()),
                    next_mutation(
                        &target.scope,
                        &space.owner,
                        CreateNote {
                            note: sample_note_id(0x95),
                            parent: None,
                            slug: "granted".into(),
                            class: DocClass::UserDoc,
                            carrier: "---\ntitle: Grant\n---\nGrant\n".into(),
                        },
                    ),
                )
                .await
                .unwrap();
        } else {
            assert_eq!(
                store.read_space(&space.scope.space_id).await.unwrap(),
                space
            );
        }
    }
    case.shutdown().await;
}
