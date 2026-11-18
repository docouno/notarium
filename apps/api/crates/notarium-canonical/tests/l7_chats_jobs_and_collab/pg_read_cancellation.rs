use super::*;
use notarium_canonical::SqlBackendConfig;
use notarium_core::error::CommitEffect;
use sqlx::Connection;

#[tokio::test]
async fn fast_pg_chat_read_releases_single_pool_slot_on_cancel_and_drop() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let data = TempDataRoot::new("fast-pg-read-cancel");
    let mut cfg = fixtures.pg_local_config(sample_installation_id(97), &schema, data.data_root());
    let SqlBackendConfig::Postgres { pool_size, .. } = &mut cfg.sql else {
        unreachable!()
    };
    *pool_size = 1;
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let owner = sample_principal_id(97);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(97),
            incarnation: sample_incarnation(97),
            root_folder_id: sample_folder_id(97),
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
    let thread = sample_thread_id(97);
    let ctx = || owner_ctx(&scope, owner.clone());
    store
        .create_chat(
            ctx(),
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
        let blocked = async {
            loop {
                if let Some(pid) = sqlx::query_scalar::<_, i32>(
                    "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
                )
                .bind(blocker_pid)
                .fetch_optional(&mut observer)
                .await
                .unwrap()
                {
                    break pid;
                }
                tokio::task::yield_now().await;
            }
        };
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
    fixtures.drop_pg_schema(&schema).await;
}
