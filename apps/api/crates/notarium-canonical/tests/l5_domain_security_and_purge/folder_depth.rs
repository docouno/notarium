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

async fn seed_wide_real_parent(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    count: u32,
) -> FolderId {
    let active_epoch = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    let parent = FolderId::from_bytes([0xE8; 16]);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch,
            folder_id: parent.clone(),
            parent: None,
            slug: "wide-real-parent".into(),
            display_name: "wide-real-parent".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    for i in 0..count {
        let mut bytes = [0u8; 16];
        bytes[0] = 0xE7;
        bytes[12..16].copy_from_slice(&i.to_be_bytes());
        let child = FolderId::from_bytes(bytes);
        let slug = format!("wc-{i:03}");
        store
            .create_folder(CreateFolderSpec {
                scope: scope.clone(),
                active_epoch,
                folder_id: child,
                parent: Some(parent.clone()),
                slug: slug.clone(),
                display_name: slug,
                is_project: false,
                project_slug: None,
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    parent
}

#[tokio::test]
async fn wide_subtree_probes_children_by_parent_before_analyze() {
    let local = TempDataRoot::new("l5-folder-depth");
    let cfg = CanonicalConfig::local_default(sample_installation_id(1), local.data_root());
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let (scope, source) = wide_tree(&store).await;
    // Exercise paged projection_read folder children (> 200 real children -> HEADS_SQLITE)
    // and verify rename_folder rejects project folders and empty batches enforce write auth.
    let owner = sample_principal_id(76);
    let sqlite_wide_parent = seed_wide_real_parent(&store, &scope, &owner, 205).await;
    let sqlite_space_rec = store.read_space(&scope.space_id).await.unwrap();
    let sqlite_cut = sqlite_space_rec.last_seq;
    let sqlite_maint = notarium_core::ports::MaintenanceContext {
        authority: notarium_core::ports::ServiceAuthority::admit(
            notarium_core::ports::ServicePurpose::Projection,
        ),
        budget: make_budget(),
    };
    let sqlite_wide_children = store
        .read_projection_folder_children_at_cut(
            &sqlite_maint,
            &scope,
            sqlite_cut,
            std::slice::from_ref(&sqlite_wide_parent),
        )
        .await
        .expect(
            "SQLite paged read_projection_folder_children_at_cut must succeed for > 200 children",
        );
    assert_eq!(
        sqlite_wide_children.len(),
        205,
        "expected 205 direct children under wide parent to exercise paged HEADS_SQLITE"
    );

    // Reject rename_folder on project folder (`is_project = 1`), and verify empty
    // accept_batch / link_many enforce Space write/read authority.
    let owner_space_ctx = owner_ctx(&scope, owner.clone(), true, true);
    let proj_id = FolderId::from_bytes([0xE9; 16]);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: sqlite_space_rec.active_epoch,
            folder_id: proj_id.clone(),
            parent: None,
            slug: "proj-no-rename".into(),
            display_name: "proj-no-rename".into(),
            is_project: true,
            project_slug: Some("proj-no-rename".into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let rename_proj_err = store
        .rename_folder(
            owner_space_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RenameFolder {
                    folder: proj_id,
                    name: "renamed-proj".into(),
                },
            ),
        )
        .await;
    assert_validation_err(&rename_proj_err, ValidationReason::InvalidState);

    let viewer_grants = std::collections::BTreeMap::from([(
        scope.space_id.clone(),
        notarium_core::auth::SpaceGrant {
            role: notarium_core::auth::SpaceRole::Viewer,
            read_classes: notarium_core::classes::DocClass::all(),
            write_classes: std::collections::BTreeSet::new(),
            project_root: None,
        },
    )]);
    let viewer_ctx = notarium_core::ports::SpaceContext::new(
        notarium_core::auth::EngineAuthContext::for_human(
            notarium_core::auth::VerifiedHuman::attest(
                owner.clone(),
                notarium_core::ids::GrantId::from_bytes([0xEE; 16]),
                viewer_grants,
                false,
            ),
        ),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let empty_batch_viewer = store
        .accept_batch(viewer_ctx.clone(), AcceptBatch { items: Vec::new() })
        .await;
    assert!(
        matches!(
            empty_batch_viewer,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "empty accept_batch by Viewer must fail SpaceReadOnly, got {empty_batch_viewer:?}"
    );
    let empty_links_viewer = store
        .link_many(viewer_ctx, LinkBatch { items: Vec::new() })
        .await;
    assert!(
        matches!(
            empty_links_viewer,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "empty link_many by Viewer must fail SpaceReadOnly, got {empty_links_viewer:?}"
    );
    let write_only_grants = std::collections::BTreeMap::from([(
        scope.space_id.clone(),
        notarium_core::auth::SpaceGrant {
            role: notarium_core::auth::SpaceRole::Editor,
            read_classes: std::collections::BTreeSet::new(),
            write_classes: notarium_core::classes::DocClass::all(),
            project_root: None,
        },
    )]);
    let write_only_ctx = notarium_core::ports::SpaceContext::new(
        notarium_core::auth::EngineAuthContext::for_human(
            notarium_core::auth::VerifiedHuman::attest(
                owner.clone(),
                notarium_core::ids::GrantId::from_bytes([0xEF; 16]),
                write_only_grants,
                false,
            ),
        ),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    assert!(
        matches!(
            store
                .accept_batch(write_only_ctx.clone(), AcceptBatch { items: Vec::new() })
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "empty accept_batch by write-only grant must fail ResourceNotFound"
    );
    assert!(
        matches!(
            store
                .link_many(write_only_ctx, LinkBatch { items: Vec::new() })
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "empty link_many by write-only grant must fail ResourceNotFound"
    );
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
        // Also verify rollback's pre-run rank revision query and compaction candidate query
        // use their exact indexes without scans, skip-scans (ANY(...)), or temp B-trees
        // both pre- and post-ANALYZE with realistic cardinality statistics.
        const PRERUN_RANK_SQL: &str =
            include_str!("../../src/domain/rollback/prerun_rank.sqlite.sql");
        const COMPACTION_CANDIDATES_SQL: &str =
            include_str!("../../src/chats/latest_compaction_candidates.sqlite.sql");
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO revisions(space_id,history_incarnation,rev_id,entity_type,entity_key,space_seq,visibility_seq,parent_rev_id,content_blake3,metadata_msgpack,actor_id,agent_run_id,created_at_sec,created_at_nsec)
                     VALUES (?1,?2,?3,'rank',?4,?5,?5,NULL,NULL,X'80','act_1',?6,1,0)",
                )
                .unwrap();
            for i in 1..=1000i64 {
                let rev = format!("rev_rk_{i:04}");
                let key = format!("rk_{}", i % 10);
                let run_opt = (i % 2 == 0).then_some("run_1");
                stmt.execute(rusqlite::params![
                    scope.space_id.as_str(),
                    scope.incarnation.as_bytes().as_slice(),
                    rev,
                    key,
                    100 + i,
                    run_opt,
                ])
                .unwrap();
            }
            let mut cstmt = conn
                .prepare(
                    "INSERT INTO chat_entries(space_id,thread_id,entry_seq,parent_seq,kind,tool_call_id,author_id,agent_run_id,inline_text,payload_blake3,referenced_notes_json,ext_space_tainted,is_chain_node,branch_depth,anc_16_seq,anc_256_seq,revision_id,created_space_seq,checkpoint_stale,body_format)
                     VALUES (?1,'thr_1',?2,?3,?4,NULL,'act_1',NULL,'hi',NULL,'[]',0,1,?2,NULL,NULL,?5,?2,0,0)",
                )
                .unwrap();
            for i in 1..=1000i64 {
                let parent = (i > 1).then_some(i - 1);
                let kind = if i == 10 || i == 250 {
                    "compaction"
                } else {
                    "human"
                };
                cstmt
                    .execute(rusqlite::params![
                        scope.space_id.as_str(),
                        i,
                        parent,
                        kind,
                        format!("rev_ch_{i:04}"),
                    ])
                    .unwrap();
            }
        }
        for phase in ["pre-ANALYZE", "post-ANALYZE"] {
            if phase == "post-ANALYZE" {
                conn.execute_batch("ANALYZE").unwrap();
            }
            let mut rank_plan = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {PRERUN_RANK_SQL}"))
                .unwrap();
            let rank_details = rank_plan
                .query_map(
                    rusqlite::params![
                        scope.space_id.as_str(),
                        scope.incarnation.as_bytes().as_slice(),
                        "rk_1",
                        "run_1",
                        900i64
                    ],
                    |r| r.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert!(
                rank_details.contains("idx_revisions_entity_vis_seq")
                    && rank_details.contains("idx_revisions_agent_run"),
                "{phase} pre-run rank query must use idx_revisions_entity_vis_seq and idx_revisions_agent_run:\n{rank_details}"
            );
            assert!(
                !rank_details.contains("SCAN ")
                    && !rank_details.contains("TEMP B-TREE")
                    && !rank_details.contains("ANY("),
                "{phase} pre-run rank query must avoid scans, skip-scans, and temp B-trees:\n{rank_details}"
            );

            let mut comp_plan = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {COMPACTION_CANDIDATES_SQL}"))
                .unwrap();
            let comp_details = comp_plan
                .query_map(
                    rusqlite::params![scope.space_id.as_str(), "thr_1", 1000i64, 64i64],
                    |r| r.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert!(
                comp_details.contains("idx_chat_entries_compaction"),
                "{phase} compaction candidate query must use idx_chat_entries_compaction:\n{comp_details}"
            );
            assert!(
                !comp_details.contains("SCAN ")
                    && !comp_details.contains("TEMP B-TREE")
                    && !comp_details.contains("ANY("),
                "{phase} compaction candidate query must avoid scans, skip-scans, and temp B-trees:\n{comp_details}"
            );
        }
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
    // Exercise paged projection_read folder children (> 200 real children -> HEADS_PG) on real PG16!
    let pg_wide_parent = seed_wide_real_parent(&store, &scope, &owner, 205).await;
    let pg_cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let pg_maint = notarium_core::ports::MaintenanceContext {
        authority: notarium_core::ports::ServiceAuthority::admit(
            notarium_core::ports::ServicePurpose::Projection,
        ),
        budget: make_budget(),
    };
    let pg_wide_children = store
        .read_projection_folder_children_at_cut(
            &pg_maint,
            &scope,
            pg_cut,
            std::slice::from_ref(&pg_wide_parent),
        )
        .await
        .expect("PostgreSQL 16 paged read_projection_folder_children_at_cut (HEADS_PG) must succeed for > 200 children");
    assert_eq!(
        pg_wide_children, sqlite_wide_children,
        "PostgreSQL HEADS_PG and SQLite HEADS_SQLITE must return identical >200 children"
    );
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
