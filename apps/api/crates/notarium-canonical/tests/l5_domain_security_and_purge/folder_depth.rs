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
                .link_many(write_only_ctx.clone(), LinkBatch { items: Vec::new() })
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "empty link_many by write-only grant must fail ResourceNotFound"
    );
    // Write-only grants (`read_classes.is_empty()`) must also be rejected on read_changes
    // (both Log and Seed) and recent_activity without disclosing last_seq or command boundaries.
    let wo_log_err = store
        .read_changes(
            write_only_ctx.clone(),
            notarium_core::ports::ChangeRead::Log {
                after: notarium_core::receipt::ChangeCursor {
                    scope: scope.clone(),
                    after: SpaceSeq::ZERO,
                },
                through: sqlite_cut,
                limit: notarium_core::ports::PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert!(
        matches!(
            wo_log_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "write-only read_changes(Log) must fail ResourceNotFound, got {wo_log_err:?}"
    );
    let wo_seed_err = store
        .read_changes(
            write_only_ctx.clone(),
            notarium_core::ports::ChangeRead::Seed {
                scope: scope.clone(),
                cutoff: None,
                limit: notarium_core::ports::PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert!(
        matches!(
            wo_seed_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "write-only read_changes(Seed) must fail ResourceNotFound, got {wo_seed_err:?}"
    );
    let wo_act_err = store
        .recent_activity(
            write_only_ctx,
            notarium_core::ports::ChangeRead::Log {
                after: notarium_core::receipt::ChangeCursor {
                    scope: scope.clone(),
                    after: SpaceSeq::ZERO,
                },
                through: sqlite_cut,
                limit: notarium_core::ports::PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert!(
        matches!(
            wo_act_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "write-only recent_activity must fail ResourceNotFound, got {wo_act_err:?}"
    );

    // Hard-purged EncryptedNote must NOT leak pre-purge Create/Update rows in recent_activity
    // even for a full-Space caller (`all_notes_visible == true`).
    let purged_enc_id = NoteId::from_bytes([0xE6; 16]);
    store
        .create_note(
            owner_space_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: purged_enc_id.clone(),
                    parent: None,
                    slug: "enc-purge-activity-check".into(),
                    class: DocClass::EncryptedNote,
                    carrier: super::valid_encrypted_carrier("Purged Secret"),
                },
            ),
        )
        .await
        .unwrap();
    store
        .delete_note(
            owner_space_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                DeleteNote {
                    note: purged_enc_id.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    let after_purge_cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let notarium_core::ports::ChangeReadResult::Log(act_page) = store
        .recent_activity(
            owner_space_ctx,
            notarium_core::ports::ChangeRead::Log {
                after: notarium_core::receipt::ChangeCursor {
                    scope: scope.clone(),
                    after: sqlite_cut,
                },
                through: after_purge_cut,
                limit: notarium_core::ports::PageLimit::new(64).unwrap(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected ChangeReadResult::Log from recent_activity");
    };
    assert!(
        !act_page.changes.iter().any(|ch| {
            ch.entity == notarium_core::ports::EntityId::Note(purged_enc_id.clone())
                && ch.lifecycle != notarium_core::model::Lifecycle::Purged
        }),
        "recent_activity must not leak pre-purge history of hard-purged EncryptedNote: {:?}",
        act_page.changes
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
        const PROJECT_ABILITY_SUBTREE_SQL: &str =
            include_str!("../../src/catalog/project_ability_subtree_version.sql");
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        {
            let mut nstmt = conn
                .prepare(
                    "INSERT INTO note_heads(space_id,note_id,parent_folder_id,slug,slug_fold,title,title_fold,doc_class,ability_id,head_rev_id,content_blake3,byte_size,lifecycle_state,visibility_mask,settlement_successor_id,created_seq,updated_seq,created_at_sec,created_at_nsec,updated_at_sec,updated_at_nsec,last_actor_id)
                     VALUES (?1,?2,?3,?4,?4,?4,?4,'user-doc',NULL,?5,?6,10,'active',0,NULL,?7,?7,1,0,1,0,'act_1')",
                )
                .unwrap();
            let digest_bytes = [0xABu8; 32];
            for i in 1..=500i64 {
                nstmt
                    .execute(rusqlite::params![
                        scope.space_id.as_str(),
                        format!("nt_ab_{i:04}"),
                        source.as_str(),
                        format!("ab-note-{i:04}"),
                        format!("rev_ab_{i:04}"),
                        digest_bytes.as_slice(),
                        1000 + i,
                    ])
                    .unwrap();
            }
            let mut apstmt = conn
                .prepare(
                    "INSERT INTO ability_packages(space_id,ability_id,kind,slug_fold,entrypoint_note_id,manifest_rev_id,resource_manifest_json,lifecycle_state,created_seq,updated_seq)
                     VALUES (?1,?2,'skill',?3,?4,?5,'{}','active',?6,?6)",
                )
                .unwrap();
            for i in 1..=3i64 {
                apstmt
                    .execute(rusqlite::params![
                        scope.space_id.as_str(),
                        format!("ab_pkg_{i:02}"),
                        format!("pkg-{i:02}"),
                        format!("nt_ab_{i:04}"),
                        format!("rev_ab_{i:04}"),
                        1000 + i,
                    ])
                    .unwrap();
            }
            // Seed 200 ability packages in a sibling project subtree of the SAME Space
            // so ANALYZE sees skewed cardinality (3 in `source` vs 200 in `folder(1)`).
            for i in 1..=200i64 {
                nstmt
                    .execute(rusqlite::params![
                        scope.space_id.as_str(),
                        format!("nt_sib_ab_{i:04}"),
                        folder(1).as_str(),
                        format!("sib-ab-note-{i:04}"),
                        format!("rev_sib_ab_{i:04}"),
                        digest_bytes.as_slice(),
                        2000 + i,
                    ])
                    .unwrap();
                apstmt
                    .execute(rusqlite::params![
                        scope.space_id.as_str(),
                        format!("ab_sib_pkg_{i:04}"),
                        format!("sib-pkg-{i:04}"),
                        format!("nt_sib_ab_{i:04}"),
                        format!("rev_sib_ab_{i:04}"),
                        2000 + i,
                    ])
                    .unwrap();
            }
            for s in 1..=20i64 {
                let other_space = format!("sp_other_{s:02}");
                for i in 1..=10i64 {
                    apstmt
                        .execute(rusqlite::params![
                            other_space,
                            format!("ab_other_{s:02}_{i:02}"),
                            format!("other-{s:02}-{i:02}"),
                            format!("nt_other_{s:02}_{i:02}"),
                            format!("rev_other_{s:02}_{i:02}"),
                            100 + i,
                        ])
                        .unwrap();
                }
            }
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

            let mut ab_plan = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {PROJECT_ABILITY_SUBTREE_SQL}"))
                .unwrap();
            let ab_details = ab_plan
                .query_map(
                    rusqlite::params![scope.space_id.as_str(), source.as_str()],
                    |r| r.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert!(
                ab_details.contains("SEARCH nh USING INDEX idx_note_heads_parent_lifecycle")
                    && ab_details.contains("SEARCH ap USING INDEX idx_ability_packages_entrypoint"),
                "{phase} project ability subtree version must drive from subtree into note_heads (idx_note_heads_parent_lifecycle) and ability_packages (idx_ability_packages_entrypoint):\n{ab_details}"
            );
            assert!(
                !ab_details.contains("SCAN note_heads")
                    && !ab_details.contains("SCAN nh")
                    && !ab_details.contains("SCAN folder_heads")
                    && !ab_details.contains("SCAN fh")
                    && !ab_details.contains("SCAN ability_packages")
                    && !ab_details.contains("SCAN ap")
                    && !ab_details.contains("TEMP B-TREE"),
                "{phase} project ability subtree version must avoid table scans and temp B-trees:\n{ab_details}"
            );

            let mut rb_coll_plan = conn
                .prepare(&format!(
                    "EXPLAIN QUERY PLAN {}",
                    notarium_canonical::ROLLBACK_ACTIVE_COLLISION_CHECK_SQLITE_SQL
                ))
                .unwrap();
            let rb_coll_details = rb_coll_plan
                .query_map(
                    rusqlite::params![
                        scope.space_id.as_str(),
                        format!(r#"[["{}","ab-note-0001"]]"#, source.as_str()),
                    ],
                    |r| r.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert!(
                rb_coll_details.contains("SEARCH nh USING INDEX uq_note_heads_active_sibling"),
                "{phase} rollback active collision probe must seek uq_note_heads_active_sibling:\n{rb_coll_details}"
            );
            assert!(
                !rb_coll_details.contains("SCAN nh")
                    && !rb_coll_details.contains("SCAN note_heads"),
                "{phase} rollback active collision probe must not scan note_heads:\n{rb_coll_details}"
            );

            let mut slug_ab_plan = conn
                .prepare(&format!(
                    "EXPLAIN QUERY PLAN {}",
                    notarium_canonical::LIST_PACKAGES_SLUG_SQLITE
                ))
                .unwrap();
            let slug_ab_details = slug_ab_plan
                .query_map(
                    rusqlite::params![scope.space_id.as_str(), "pkg-01", "", 16i64],
                    |r| r.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert!(
                slug_ab_details.contains("idx_ability_packages_active_slug")
                    && !slug_ab_details.contains("USE TEMP B-TREE"),
                "{phase} slug-filtered ability catalog query must use idx_ability_packages_active_slug without temp sort:\n{slug_ab_details}"
            );
            assert!(
                !slug_ab_details.contains("SCAN ability_packages"),
                "{phase} slug-filtered ability catalog query must not scan ability_packages:\n{slug_ab_details}"
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
