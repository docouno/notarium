use super::*;

const SQLITE_QUERY: &str = include_str!("../../src/domain/folder_subtree.sqlite.sql");
const PG_QUERY: &str = include_str!("../../src/domain/folder_subtree.postgres.sql");

fn folder(index: u32) -> FolderId {
    FolderId::from_bytes(u128::from(index + 10_000).to_be_bytes())
}

async fn wide_tree(store: &CanonicalStore) -> (HistoryScope, FolderId) {
    let owner = sample_principal_id(76);
    let (scope, root) = seed_default_space(
        store,
        sample_space_id(76),
        sample_incarnation(76),
        owner.clone(),
    )
    .await;
    // Source at depth 1, 1,000 direct children, and a separate branch 254 levels deep.
    let mut rows = vec![
        (folder(0), root.clone()),
        (folder(1), root.clone()),
        (folder(2), root.clone()),
        (folder(3), folder(1)),
    ];
    rows.extend((4..1004).map(|i| (folder(i), folder(0))));
    for depth in 0..254 {
        rows.push((
            folder(1004 + depth),
            if depth == 0 {
                folder(0)
            } else {
                folder(1003 + depth)
            },
        ));
    }
    for chunk in rows.chunks(100) {
        let values: Vec<_> = chunk
            .iter()
            .map(|(id, parent)| {
                let id = id.as_str();
                format!(
                    "('{}','{id}','{}',0,'{id}','{id}','{id}',0,'active',1,'{rev}',1,1,0,0)",
                    scope.space_id.as_str(),
                    parent.as_str(),
                    rev = notarium_core::ids::RevisionId::from_bytes([71; 16]).as_str()
                )
            })
            .collect();
        store.execute_diagnostic_write_sql_for_test(&format!("INSERT INTO folder_heads (space_id,folder_id,parent_folder_id,is_root,slug,slug_fold,display_name,is_project,lifecycle_state,rev_seq,head_rev_id,created_seq,updated_seq,updated_at_sec,updated_at_nsec) VALUES {}",values.join(","))).await.unwrap();
    }
    let ctx = owner_ctx(&scope, owner.clone(), true, true);
    let move_to = |parent: FolderId| {
        store.move_folder(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveFolder {
                    folder: folder(0),
                    new_parent: Some(parent),
                },
            ),
        )
    };
    move_to(folder(1))
        .await
        .expect("deepest descendant at depth 256");
    let seq = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert_validation_err(&move_to(folder(3)).await, ValidationReason::InvalidState);
    assert_validation_err(&move_to(folder(4)).await, ValidationReason::InvalidState);
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        seq
    );
    move_to(folder(2)).await.expect("same depth");
    move_to(root).await.expect("shallower destination");
    (scope, folder(0))
}

#[tokio::test]
async fn wide_subtree_probes_children_by_parent_before_analyze() {
    let local = TempDataRoot::new("l5-folder-depth");
    let cfg = CanonicalConfig::local_default(sample_installation_id(1), local.data_root());
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let (scope, source) = wide_tree(&store).await;
    {
        let conn = rusqlite::Connection::open(local.data_root().canonical()).unwrap();
        let mut plan = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {SQLITE_QUERY}"))
            .unwrap();
        let details = plan
            .query_map(
                rusqlite::params![scope.space_id.as_str(), source.as_str(), 255],
                |r| r.get::<_, String>(3),
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");
        assert!(details.contains("idx_folder_heads_parent_lifecycle (space_id=? AND parent_folder_id=? AND lifecycle_state=?)"),"{details}");
        let mut query = conn.prepare(SQLITE_QUERY).unwrap();
        assert!(
            !query
                .query_row(
                    rusqlite::params![scope.space_id.as_str(), source.as_str(), 255],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap()
        );
        assert!(
            query.get_status(rusqlite::StatementStatus::VmStep) < 100_000,
            "1,254 descendants must not trigger repeated Space scans"
        );
    }
    runtime.shutdown().await.unwrap();

    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let pg_local = TempDataRoot::new("l5-folder-depth-pg");
    let mut cfg = CanonicalConfig::local_default(sample_installation_id(2), pg_local.data_root());
    cfg.sql = notarium_canonical::SqlBackendConfig::postgres_default(
        fixtures.pg_connect_config(),
        &schema,
    );
    cfg.default_backup_budget = notarium_canonical::config::default_postgres_backup_budget();
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let (scope, source) = wide_tree(&store).await;
    let mut conn = fixtures.open_raw_pg().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "SET search_path TO {schema}; SET plan_cache_mode=force_generic_plan"
    )))
    .execute(&mut conn)
    .await
    .unwrap();
    let sql = format!("EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) {PG_QUERY}");
    let details = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql))
        .bind(scope.space_id.as_str())
        .bind(source.as_str())
        .bind(255i64)
        .fetch_all(&mut conn)
        .await
        .unwrap()
        .join("\n");
    assert!(
        details.lines().any(|line| line.contains("Index Cond:")
            && line.contains("space_id")
            && line.contains("parent_folder_id")),
        "{details}"
    );
    assert!(!details.contains("Seq Scan on folder_heads"), "{details}");
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
