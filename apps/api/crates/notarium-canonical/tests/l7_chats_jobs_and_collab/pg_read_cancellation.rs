use super::*;
use notarium_canonical::SqlBackendConfig;
use notarium_core::error::CommitEffect;
use sqlx::Connection;

async fn waiting_reader_pid(
    observer: &mut sqlx::PgConnection,
    blocker: i32,
    previous: Option<i32>,
) -> i32 {
    loop {
        if let Some(pid) = sqlx::query_scalar::<_, i32>(
            "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND pid IS DISTINCT FROM $2::int",
        )
        .bind(blocker)
        .bind(previous)
        .fetch_optional(&mut *observer)
        .await
        .unwrap()
        {
            return pid;
        }
        tokio::task::yield_now().await;
    }
}

async fn seed_personal_chat(
    store: &CanonicalStore,
    seed: u8,
) -> (HistoryScope, PrincipalId, ChatThreadId) {
    let owner = sample_principal_id(seed);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed),
            incarnation: sample_incarnation(seed),
            root_folder_id: sample_folder_id(seed),
            slug: "read-cancellation".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
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
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    title: "Cancellable read".into(),
                    project_folder: None,
                },
            ),
        )
        .await
        .unwrap();
    (scope, owner, thread)
}

#[tokio::test]
async fn fast_pg_chat_read_releases_slots_on_cancel_drop_and_shutdown() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let data = TempDataRoot::new("fast-pg-read-cancel");
    let mut cfg = fixtures.pg_local_config(sample_installation_id(97), &schema, data.data_root());
    let SqlBackendConfig::Postgres { pool_size, .. } = &mut cfg.sql else {
        unreachable!()
    };
    *pool_size = 1;
    let (store, runtime) = CanonicalRuntime::open(cfg.clone()).await.unwrap();
    let (scope, owner, thread) = seed_personal_chat(&store, 97).await;
    let ctx = || owner_ctx(&scope, owner.clone());
    let leaf = store
        .append_chat(
            ctx(),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("one".into()),
                    referenced_notes: vec![],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap()
        .value
        .seq;
    let request = ChatRead {
        thread,
        leaf,
        before: None,
        max_entries: PageLimit::new(1).unwrap(),
    };
    let mut blocker = fixtures.open_raw_pg().await;
    let mut observer = fixtures.open_raw_pg().await;
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut blocker)
        .await
        .unwrap();
    for drop_caller in [false, true] {
        let mut lock = blocker.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "LOCK TABLE {schema}.chat_entries IN ACCESS EXCLUSIVE MODE"
        )))
        .execute(&mut *lock)
        .await
        .unwrap();
        let active = ctx();
        let cancel = active.budget.cancellation.clone();
        let mut read = store.read_chat(active, request.clone());
        let blocked = waiting_reader_pid(&mut observer, blocker_pid, None);
        let pid = tokio::select! {
            result = &mut read => panic!("expected the chat query to block: {result:?}"),
            pid = blocked => pid,
        };
        let waiting = ctx();
        let cancel_wait = waiting.budget.cancellation.clone();
        let mut checkout = store.read_chat(waiting, request.clone());
        assert!(futures_util::poll!(checkout.as_mut()).is_pending());
        cancel_wait.cancel();
        assert!(
            matches!(checkout.await, Err(PortError::Cancelled(e)) if e.effect() == CommitEffect::NotCommitted)
        );
        if drop_caller {
            drop(read);
        } else {
            cancel.cancel();
            assert!(
                matches!(read.await, Err(PortError::Cancelled(e)) if e.effect() == CommitEffect::NotCommitted)
            );
        }
        lock.rollback().await.unwrap();
        let fresh = store.read_chat(ctx(), request.clone()).await.unwrap();
        assert_eq!(fresh.entries.len(), 1);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let active: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1)",
                )
                .bind(pid)
                .fetch_one(&mut observer)
                .await
                .unwrap();
                if !active {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the cancelled connection must leave the pool");
    }
    runtime.shutdown().await.unwrap();
    // With a cacheable pool, a successful in-flight read must return its
    // connection if shutdown has already drained the idle cache.
    let SqlBackendConfig::Postgres { pool_size, .. } = &mut cfg.sql else {
        unreachable!()
    };
    *pool_size = 3;
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let mut lock = blocker.begin().await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "LOCK TABLE {schema}.chat_entries IN ACCESS EXCLUSIVE MODE"
    )))
    .execute(&mut *lock)
    .await
    .unwrap();
    let mut read = store.read_chat(ctx(), request);
    tokio::select! {
        result = &mut read => panic!("expected an in-flight read: {result:?}"),
        _ = waiting_reader_pid(&mut observer, blocker_pid, None) => {}
    }
    let stopping = tokio::spawn(runtime.shutdown());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match store.read_space(&scope.space_id).await {
                Err(PortError::Unavailable(_)) => break,
                Ok(_) => tokio::task::yield_now().await,
                other => panic!("unexpected Space read during shutdown: {other:?}"),
            }
        }
    })
    .await
    .expect("shutdown must stop new reads");
    lock.rollback().await.unwrap();
    assert_eq!(read.await.unwrap().entries.len(), 1);
    tokio::time::timeout(Duration::from_secs(2), stopping)
        .await
        .expect("shutdown must drain a late cache return")
        .unwrap()
        .unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn pg_pool_returns_foreign_checkout_to_the_store_runtime() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let data = TempDataRoot::new("foreign-pg-checkout");
    let mut cfg = fixtures.pg_local_config(sample_installation_id(98), &schema, data.data_root());
    let SqlBackendConfig::Postgres { pool_size, .. } = &mut cfg.sql else {
        unreachable!()
    };
    *pool_size = 1;
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();

    const PID: &str = "SELECT pg_backend_pid()::bigint";
    let initial = store
        .execute_diagnostic_read_sql_for_test(None, PID)
        .await
        .unwrap();
    // A failed transaction discards the one checkout. The foreign caller must
    // now establish a new physical connection, even with an otherwise idle pool.
    assert!(matches!(
        store
            .execute_diagnostic_read_sql_for_test(None, "SELECT 1::bigint / 0")
            .await,
        Err(PortError::Internal(_))
    ));
    let caller = store.clone();
    let foreign_pid = tokio::task::spawn_blocking(move || {
        let foreign = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        foreign
            .block_on(caller.execute_diagnostic_read_sql_for_test(None, PID))
            .unwrap()
    })
    .await
    .unwrap();
    assert_ne!(initial, foreign_pid);
    assert_eq!(
        store
            .execute_diagnostic_read_sql_for_test(None, PID)
            .await
            .unwrap(),
        foreign_pid
    );
    let mut observer = fixtures.open_raw_pg().await;
    let pid = i32::try_from(foreign_pid).unwrap();
    sqlx::query("SELECT pg_advisory_lock(14823,$1)")
        .bind(pid)
        .execute(&mut observer)
        .await
        .unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let caller = store.clone();
    let foreign = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            tokio::spawn(async move {
                caller
                    .execute_diagnostic_write_sql_for_test(&format!(
                        "SELECT pg_advisory_xact_lock(14823,{pid})"
                    ))
                    .await
            });
            stopped.await.unwrap();
        });
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT cardinality(pg_blocking_pids($1)) > 0")
                .bind(pid)
                .fetch_one(&mut observer)
                .await
                .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the foreign transaction holds the surviving checkout");
    stop.send(()).unwrap();
    foreign.await.unwrap();
    sqlx::query("SELECT pg_advisory_unlock(14823,$1)")
        .bind(pid)
        .execute(&mut observer)
        .await
        .unwrap();
    let replacement = store
        .execute_diagnostic_read_sql_for_test(None, PID)
        .await
        .unwrap();
    assert_ne!(
        replacement, foreign_pid,
        "a checkout interrupted during SQL must close"
    );
    runtime.shutdown().await.unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let live: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid IN ($1,$2))",
            )
            .bind(pid)
            .bind(i32::try_from(replacement).unwrap())
            .fetch_one(&mut observer)
            .await
            .unwrap();
            if !live {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("shutdown closes the surviving pooled connection");
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn pg_append_chat_rechecks_an_expired_read_before_writer_admission() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let data = TempDataRoot::new("pg-chat-read-deadline");
    let config = fixtures.pg_local_config(sample_installation_id(89), &schema, data.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let (scope, owner, thread) = seed_personal_chat(&store, 89).await;
    let ctx = || owner_ctx(&scope, owner.clone());
    let mut blocker = fixtures.open_raw_pg().await;
    let mut observer = fixtures.open_raw_pg().await;
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut blocker)
        .await
        .unwrap();
    for (index, table) in ["command_receipts", "spaces"].into_iter().enumerate() {
        let mut lock = blocker.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "LOCK TABLE {schema}.{table} IN ACCESS EXCLUSIVE MODE"
        )))
        .execute(&mut *lock)
        .await
        .unwrap();
        let command = next_mutation(
            &scope,
            &owner,
            AppendChat {
                thread: thread.clone(),
                parent: ThreadEntrySeq::ZERO,
                kind: ChatEntryKind::Human,
                body: ChatInputBody::Text(format!("branch {index}")),
                referenced_notes: vec![],
                tainted: false,
            },
        );
        let mut append = store.append_chat(ctx(), command.clone());
        let first = tokio::select! {
            result = &mut append => panic!("append must wait at {table}: {result:?}"),
            first = tokio::time::timeout(Duration::from_secs(5), waiting_reader_pid(&mut observer, blocker_pid, None)) => first.unwrap(),
        };
        tokio::select! {
            result = &mut append => panic!("an expired read must leave time for a fresh snapshot at {table}: {result:?}"),
            second = tokio::time::timeout(Duration::from_secs(5), waiting_reader_pid(&mut observer, blocker_pid, Some(first))) => {
                second.expect("the fresh read must reach the locked table");
            }
        }
        lock.rollback().await.unwrap();
        let result = append.await.unwrap();
        assert_eq!(result.value.seq.get(), u64::try_from(index).unwrap() + 1);
        let replay = store.append_chat(ctx(), command).await.unwrap();
        assert_eq!(replay.receipt, result.receipt);
        assert_eq!(replay.value.seq, result.value.seq);
    }
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
