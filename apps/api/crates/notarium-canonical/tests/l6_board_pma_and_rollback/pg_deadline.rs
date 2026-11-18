use super::*;
use notarium_core::error::{CommitEffect, RetryAdvice};
use std::time::Duration;

async fn wait_for_blocked_session(db: &mut sqlx::PgConnection) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pg_backend_pid()=ANY(pg_blocking_pids(pid)))")
                .fetch_one(&mut *db).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }).await.expect("a fixture connection must wait behind this session");
}

#[tokio::test]
async fn postgres_rollback_deadline_covers_safe_point_pool_and_commit_ack() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let root = TempDataRoot::new("l6-rollback-deadline");
    let mut config = CanonicalConfig::local_default(sample_installation_id(76), root.data_root());
    let mut sql = notarium_canonical::SqlBackendConfig::postgres_default(
        fixtures.pg_connect_config(),
        &schema,
    );
    if let notarium_canonical::SqlBackendConfig::Postgres { pool_size, .. } = &mut sql {
        *pool_size = 1;
    }
    config.sql = sql;
    config.default_backup_budget = notarium_canonical::config::default_postgres_backup_budget();
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let owner = sample_principal_id(76);
    let (scope, _) = seed_space(
        &store,
        sample_space_id(76),
        sample_incarnation(76),
        owner.clone(),
    )
    .await;
    let human = owner_ctx(&scope, owner.clone());
    let run = sample_run_id(76);
    let made = store
        .create_note(
            agent_run_ctx(&human, run.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: sample_note_id(76),
                    parent: None,
                    slug: "sample".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Sample\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    let expected = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
        .await
        .unwrap()
        .unwrap();
    let command = next_mutation(
        &scope,
        &owner,
        RollbackAgentRun {
            run,
            expected_run_revision: expected,
            expected_entities: vec![made.value],
            associated_board_expectations: Vec::new(),
        },
    );
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let pause = store.acquire_writer_safe_point().await.unwrap();
    let mut short = human.clone();
    short.budget.remaining = Duration::from_millis(30);
    let failure = tokio::time::timeout(
        Duration::from_secs(2),
        store.rollback_agent_run(short.clone(), command.clone()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(
        matches!(failure, PortError::DeadlineExceeded(f) if f.effect()==CommitEffect::NotCommitted)
    );
    let cancelled = human.clone();
    let token = cancelled.budget.cancellation.clone();
    let mut blocked = Box::pin(store.rollback_agent_run(cancelled, command.clone()));
    tokio::select! { biased; result=&mut blocked=>panic!("safe point failed to block {result:?}"), _=tokio::time::sleep(Duration::from_millis(5))=>{} }
    token.cancel();
    let failure = tokio::time::timeout(Duration::from_secs(2), blocked)
        .await
        .unwrap()
        .unwrap_err();
    assert!(matches!(failure,PortError::Cancelled(f) if f.effect()==CommitEffect::NotCommitted));
    drop(pause);

    let mut db = fixtures.open_raw_pg().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "SET search_path TO {schema}; SELECT pg_advisory_lock(hashtext('{schema}'))"
    )))
    .execute(&mut db)
    .await
    .unwrap();
    let db_store = store.clone();
    let lock_sql = format!("SELECT pg_advisory_xact_lock(hashtext('{schema}'))");
    let checkout = tokio::spawn(async move {
        db_store
            .execute_diagnostic_write_sql_for_test(&lock_sql)
            .await
            .unwrap()
    });
    wait_for_blocked_session(&mut db).await;
    let mut short = owner_ctx(&scope, owner.clone());
    short.budget.remaining = Duration::from_millis(30);
    let failure = tokio::time::timeout(
        Duration::from_secs(2),
        store.rollback_agent_run(short, command.clone()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(
        matches!(failure,PortError::DeadlineExceeded(f) if f.effect()==CommitEffect::NotCommitted)
    );
    sqlx::query("SELECT pg_advisory_unlock_all()")
        .execute(&mut db)
        .await
        .unwrap();
    checkout.await.unwrap();
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before
    );

    // The ordinary PostgreSQL read ceiling also applies with a long caller budget.
    sqlx::raw_sql("BEGIN; LOCK TABLE agent_run_heads IN ACCESS EXCLUSIVE MODE")
        .execute(&mut db)
        .await
        .unwrap();
    let failure = tokio::time::timeout(
        Duration::from_secs(2),
        store.rollback_agent_run(owner_ctx(&scope, owner.clone()), command.clone()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(
        matches!(failure, PortError::DeadlineExceeded(f) if f.effect()==CommitEffect::NotCommitted)
    );
    sqlx::query("ROLLBACK").execute(&mut db).await.unwrap();
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before
    );

    // A deferred trigger runs only after the client has sent COMMIT.
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE FUNCTION block_rollback_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtext('{schema}')); RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER block_rollback_commit AFTER UPDATE ON agent_run_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION block_rollback_commit();
        SELECT pg_advisory_lock(hashtext('{schema}'))"))).execute(&mut db).await.unwrap();
    let ctx = owner_ctx(&scope, owner.clone());
    let token = ctx.budget.cancellation.clone();
    let mut pending = Box::pin(store.rollback_agent_run(ctx, command.clone()));
    tokio::select! { result=&mut pending=>panic!("missing deferred COMMIT lock: {result:?}"), _=wait_for_blocked_session(&mut db)=>{} }
    token.cancel();
    let failure = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap_err();
    assert!(
        matches!(failure,PortError::Unavailable(f) if f.effect()==CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand),
        "{failure:?}"
    );
    let mut safe_point = Box::pin(store.acquire_writer_safe_point());
    tokio::select! {
        biased;
        _ = &mut safe_point => panic!("in-flight COMMIT escaped the backup gate"),
        _ = tokio::time::sleep(Duration::from_millis(10)) => {}
    }
    sqlx::query("SELECT pg_advisory_unlock_all()")
        .execute(&mut db)
        .await
        .unwrap();
    drop(
        tokio::time::timeout(Duration::from_secs(2), safe_point)
            .await
            .unwrap()
            .unwrap(),
    );
    let ctx = owner_ctx(&scope, owner);
    let result = store
        .rollback_agent_run(ctx.clone(), command.clone())
        .await
        .unwrap();
    let retry = store.rollback_agent_run(ctx, command).await.unwrap();
    assert_eq!(result.receipt, retry.receipt);
    assert_eq!(result.value.trashed.len(), 1);
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn postgres_read_admission_statements_and_snapshot_have_distinct_deadlines() {
    use notarium_core::{
        ids::{ChatThreadId, ThreadEntrySeq},
        ports::{ChatPort, ChatRead, PageLimit},
    };
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let root = TempDataRoot::new("l6-pg-read-budgets");
    let mut config = CanonicalConfig::local_default(sample_installation_id(77), root.data_root());
    config.sql = notarium_canonical::SqlBackendConfig::postgres_default(
        fixtures.pg_connect_config(),
        &schema,
    );
    let statement = Duration::from_millis(120);
    if let notarium_canonical::SqlBackendConfig::Postgres {
        pool_size,
        statement_timeout,
        ..
    } = &mut config.sql
    {
        *pool_size = 1;
        *statement_timeout = statement;
    }
    config.default_backup_budget = notarium_canonical::config::default_postgres_backup_budget();
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let owner = sample_principal_id(77);
    let (scope, _) = seed_space(
        &store,
        sample_space_id(77),
        sample_incarnation(77),
        owner.clone(),
    )
    .await;
    let ctx = owner_ctx(&scope, owner.clone());
    let note = sample_note_id(77);
    let created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "timing".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Timing\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    let renamed = store
        .rename_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RenameNote {
                    note: note.clone(),
                    slug: "new-timing".into(),
                    title: None,
                },
            ),
        )
        .await
        .unwrap();
    let historical = GetNote {
        note,
        revision: Some(created.value.revision),
        causal: CausalBasis::Exact(ReceiptSet::new([renamed.receipt]).unwrap()),
    };

    // Two distinct point lookups wait 70 ms each. Neither exceeds the 120 ms statement limit.
    let mut spaces = fixtures.open_raw_pg().await;
    let mut fences = fixtures.open_raw_pg().await;
    for (db, table) in [
        (&mut spaces, "spaces"),
        (&mut fences, "revision_purge_fences"),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "BEGIN; LOCK TABLE \"{schema}\".{table} IN ACCESS EXCLUSIVE MODE"
        )))
        .execute(db)
        .await
        .unwrap();
    }
    let (locked, wait_for_first) = tokio::sync::oneshot::channel();
    let release = async {
        wait_for_blocked_session(&mut spaces).await;
        locked.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(70)).await;
        sqlx::raw_sql("COMMIT").execute(&mut spaces).await.unwrap();
        wait_for_blocked_session(&mut fences).await;
        tokio::time::sleep(Duration::from_millis(70)).await;
        sqlx::raw_sql("COMMIT").execute(&mut fences).await.unwrap();
    };
    let wait_for_pool = async {
        wait_for_first.await.unwrap();
        let started = std::time::Instant::now();
        let one = store
            .execute_diagnostic_read_sql_for_test(Some(&ctx.budget), "SELECT 1::bigint")
            .await
            .unwrap();
        assert_eq!(one, 1);
        assert!(started.elapsed() >= statement);
    };
    let (read, (), ()) = tokio::join!(
        store.get_note(ctx.clone(), historical.clone()),
        release,
        wait_for_pool
    );
    assert!(read.is_ok(), "{read:?}");

    let expired = store
        .execute_diagnostic_read_sql_for_test(
            Some(&ctx.budget),
            "SELECT 1::bigint FROM pg_sleep(2)",
        )
        .await
        .unwrap_err();
    assert!(
        matches!(expired, PortError::DeadlineExceeded(ref failure) if failure.effect()==CommitEffect::NotCommitted),
        "{expired:?}"
    );

    let mut short = ctx.clone();
    short.budget.remaining = Duration::from_millis(30);
    let timeout = store
        .execute_diagnostic_read_sql_for_test(
            Some(&short.budget),
            "SELECT 1::bigint FROM pg_sleep(2)",
        )
        .await
        .unwrap_err();
    assert!(matches!(timeout, PortError::DeadlineExceeded(_)));
    assert_eq!(
        store
            .execute_diagnostic_read_sql_for_test(Some(&ctx.budget), "SELECT 2::bigint")
            .await
            .unwrap(),
        2
    );

    // Cancel a real autocommit ChatRead with the server VM blocked on this lock.
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "BEGIN; LOCK TABLE \"{schema}\".chat_threads IN ACCESS EXCLUSIVE MODE"
    )))
    .execute(&mut spaces)
    .await
    .unwrap();
    let mut other = ctx.clone();
    other.budget.cancellation = Cancellation::default();
    let cancel = other.budget.cancellation.clone();
    let release = async {
        wait_for_blocked_session(&mut spaces).await;
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let still_blocked: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pg_backend_pid()=ANY(pg_blocking_pids(pid)))")
                    .fetch_one(&mut spaces).await.unwrap();
                if !still_blocked { break; }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }).await.expect("the canceled PostgreSQL reader must release its backend");
        sqlx::raw_sql("COMMIT").execute(&mut spaces).await.unwrap();
    };
    let request = ChatRead {
        thread: ChatThreadId::from_bytes([77; 16]),
        leaf: ThreadEntrySeq::new(1).unwrap(),
        before: None,
        max_entries: PageLimit::new(4).unwrap(),
    };
    let (result, ()) = tokio::join!(store.read_chat(other, request), release);
    assert!(matches!(result, Err(PortError::Cancelled(_))));
    assert!(store.get_note(ctx, historical).await.is_ok());
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
