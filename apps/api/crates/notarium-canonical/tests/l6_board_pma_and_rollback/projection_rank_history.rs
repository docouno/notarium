use super::*;

pub(super) async fn check_board_exit_tombstones_rank(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    planner: &CanonicalTestBoardPlanner,
    view: &ViewRef,
    view_revision: RevisionId,
) {
    let human = owner_ctx(scope, owner.clone());
    let card = sample_note_id(120);
    let original = store
        .create_note(
            human.clone(),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    note: card.clone(),
                    parent: None,
                    slug: "card-outside-view".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\nstatus: archived\n---\nCard\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    planner.tracked_notes.lock().unwrap().insert(card.clone());
    let run = sample_run_id(12);
    let moved = store
        .move_board_card(
            agent_run_ctx(&human, run.clone()),
            next_mutation(
                scope,
                owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: card.clone(),
                    group: GroupKey::Value(ScalarValue::String("holding".to_owned())),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("holding".to_owned())),
                    )]),
                    expected_note: original.value.revision,
                    expected_view: view_revision,
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    let overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, view)
        .await
        .unwrap();
    let restored = store
        .rollback_agent_run(
            human.clone(),
            next_mutation(
                scope,
                owner,
                RollbackAgentRun {
                    expected_run_revision: store
                        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
                        .await
                        .unwrap()
                        .unwrap(),
                    run,
                    expected_entities: vec![moved.value.revision],
                    associated_board_expectations: vec![AssociatedBoardExpectation {
                        note: card.clone(),
                        view: view.clone(),
                        expected_rank: RankExpectation::Existing(moved.value.rank_revision.clone()),
                        expected_placement_revision: overlays[&card].placement_revision.clone(),
                    }],
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(restored.receipt.seq().get() - moved.receipt.seq().get(), 2);
    assert!(restored.value.trashed.is_empty());
    assert_eq!(restored.value.restored[0].note, card);
    assert!(store.is_live_visible(&human, &card).await.unwrap());
    assert!(
        !store
            .inspect_view_overlays_for_test(&scope.space_id, view)
            .await
            .unwrap()
            .contains_key(&card)
    );
    let tombstone = store
        .read_entity_revision_at_cutoff(
            scope,
            "rank",
            &format!("{}:{}:{card}", view.note, view.key),
            Some(restored.receipt.seq()),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        tombstone.metadata.payload,
        notarium_canonical::codec::RevisionMetadataPayload::Rank(rank) if rank.removed
    ));
}

async fn check_note_only_rollback_deletes_ranks(store: &CanonicalStore, postgres: bool) {
    use notarium_core::ports::{DeleteDisposition, DeleteNote};

    let owner = sample_principal_id(61);
    let run = sample_run_id(61);
    let (scope, _) = seed_space(
        store,
        sample_space_id(61),
        sample_incarnation(61),
        owner.clone(),
    )
    .await;
    let human = owner_ctx(&scope, owner.clone());
    let agent = agent_run_ctx(&human, run.clone());
    let view = sample_note_id(61);
    let card = sample_note_id(62);
    let survivor = sample_note_id(63);
    let inactive = sample_note_id(64);
    let mut expected_entities = Vec::new();
    for (note, slug, in_run) in [
        (&view, "run-view", true),
        (&card, "run-card", true),
        (&survivor, "live-note", false),
        (&inactive, "previously-trashed", false),
    ] {
        let context = if in_run { agent.clone() } else { human.clone() };
        let committed = store
            .create_note(
                context,
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        note: note.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: "Body".to_owned(),
                    },
                ),
            )
            .await
            .unwrap();
        if in_run {
            expected_entities.push(committed.value);
        }
    }
    for (context, disposition) in [
        (human.clone(), DeleteDisposition::Trash),
        (agent, DeleteDisposition::Restore),
    ] {
        let result = store
            .delete_note(
                context,
                next_mutation(
                    &scope,
                    &owner,
                    DeleteNote {
                        note: inactive.clone(),
                        disposition,
                    },
                ),
            )
            .await
            .unwrap();
        if disposition == DeleteDisposition::Restore {
            expected_entities.push(result.value);
        }
    }

    // A v6 installation may have live overlays without board-move history.
    // Two run-owned endpoints share one row. Other rows hit only one endpoint.
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let (group, group_hex) = notarium_canonical::codec::group_key_hex(&GroupKey::Absent).unwrap();
    let group_bytes = hex::encode(group);
    let binary = if postgres {
        format!("decode('{group_bytes}', 'hex')")
    } else {
        format!("X'{group_bytes}'")
    };
    let key = ViewKey::from_bytes([61; 16]);
    let mut pairs = Vec::new();
    for (ordinal, (view, target)) in [
        (&view, &card),
        (&view, &survivor),
        (&survivor, &card),
        (&survivor, &inactive),
        (&inactive, &survivor),
    ]
    .into_iter()
    .enumerate()
    {
        let prior = RevisionId::from_bytes([ordinal as u8; 16]);
        let inserted = store
            .execute_diagnostic_write_sql_for_test(&format!(
                "INSERT INTO view_rank_overlays VALUES
             ('{}', '{view}', '{key}', '{target}', {binary}, '{group_hex}', '000000000007',
              '{prior}', '{prior}', '{owner}', NULL, {})",
                scope.space_id,
                before.get(),
            ))
            .await
            .unwrap();
        assert_eq!(inserted, 1);
        pairs.push((view, target, prior));
    }
    let rollback = store
        .rollback_agent_run(
            human,
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    expected_run_revision: store
                        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
                        .await
                        .unwrap()
                        .unwrap(),
                    run,
                    expected_entities,
                    associated_board_expectations: Vec::new(),
                },
            ),
        )
        .await
        .unwrap();
    let cut = rollback.receipt.seq();
    assert_eq!(rollback.value.trashed.len(), 2);
    assert_eq!(rollback.value.restored[0].note, inactive);
    assert_eq!(cut.get() - before.get(), 8);
    for (view, target, prior) in pairs {
        let view_ref = ViewRef {
            note: view.clone(),
            key: key.clone(),
        };
        assert!(
            !store
                .inspect_view_overlays_for_test(&scope.space_id, &view_ref)
                .await
                .unwrap()
                .contains_key(target)
        );
        let stored = store
            .read_entity_revision_at_cutoff(
                &scope,
                "rank",
                &format!("{view}:{key}:{target}"),
                Some(cut),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.visibility_seq, cut);
        assert!(stored.space_seq > before);
        assert!(matches!(
            stored.metadata.payload,
            notarium_canonical::codec::RevisionMetadataPayload::Rank(rank)
                if rank.removed && rank.placement_revision == prior
        ));
    }
}

#[tokio::test]
async fn l6_note_only_rollback_tombstones_both_rank_endpoints() {
    let root = TempDataRoot::new("rank-removal-sqlite");
    let config = CanonicalConfig::local_default(sample_installation_id(91), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    check_note_only_rollback_deletes_ranks(&store, false).await;
    runtime.shutdown().await.unwrap();

    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let root = TempDataRoot::new("rank-removal-postgres");
    let config = fixtures.pg_local_config(sample_installation_id(92), &schema, root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    check_note_only_rollback_deletes_ranks(&store, true).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn l6_v6_rank_anchor_is_atomic_survives_restore_and_is_erased_by_purge() {
    use notarium_core::{
        ports::{BackupParticipantPort, DeleteDisposition, DeleteNote, PageLimit, ServicePurpose},
        receipt::ChangeCursor,
    };
    use support::{CANONICAL_V6_HASH, maintenance_ctx};

    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let installation = sample_installation_id(66);
    for postgres in [false, true] {
        let temp = TempDataRoot::new("rank-anchor-migration");
        let config = if postgres {
            fixtures.pg_local_config(installation.clone(), &schema, temp.data_root())
        } else {
            CanonicalConfig::local_default(installation.clone(), temp.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
        let owner = sample_principal_id(66);
        let (scope, _) = seed_space(
            &store,
            sample_space_id(66),
            sample_incarnation(66),
            owner.clone(),
        )
        .await;
        let empty = store
            .create_space(CreateSpaceSpec {
                space_id: sample_space_id(67),
                incarnation: sample_incarnation(67),
                root_folder_id: sample_folder_id(67),
                slug: "rank-anchor-empty".to_owned(),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let ctx = owner_ctx(&scope, owner.clone());
        let view = ViewRef {
            note: sample_note_id(66),
            key: ViewKey::from_bytes([66; 16]),
        };
        let surviving = sample_note_id(67);
        let deleted = sample_note_id(68);
        let create = |note, slug: &str, status| {
            let carrier = format!("---\nstatus: {status}\n---\nBody\n");
            store.create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        note,
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier,
                    },
                ),
            )
        };
        let view_revision = create(view.note.clone(), "anchor-view", "todo")
            .await
            .unwrap();
        let kept = create(surviving.clone(), "kept", "todo").await.unwrap();
        let lost = create(deleted.clone(), "removed", "doing").await.unwrap();
        store
            .register_board_facts_provider(CanonicalTestBoardPlanner::new(
                store.clone(),
                [surviving.clone(), deleted.clone()],
            ))
            .unwrap();
        let mut height = SpaceSeq::ZERO;
        let mut before = SpaceSeq::ZERO;
        let mut retained_rank = None;
        for (created, status) in [(lost, "doing"), (kept, "todo")] {
            let commit = store
                .move_board_card(
                    ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        MoveBoardCard {
                            view: view.clone(),
                            note: created.value.note.clone(),
                            group: GroupKey::Value(ScalarValue::String(status.to_owned())),
                            before: None,
                            after: None,
                            fields: BTreeMap::new(),
                            expected_note: created.value.revision,
                            expected_view: view_revision.value.revision.clone(),
                            expected_rank: RankExpectation::Absent,
                        },
                    ),
                )
                .await
                .unwrap();
            before = height;
            height = commit.receipt.seq();
            if created.value.note == surviving {
                retained_rank = Some(commit.value.rank_revision);
            }
        }
        assert!(before > SpaceSeq::ZERO && height > before);
        // Reproduce the missing pre-v7 tombstone while retaining the immutable rank history.
        store.execute_diagnostic_write_sql_for_test(&format!(
            "DELETE FROM view_rank_overlays WHERE space_id = '{}' AND target_note_id = '{deleted}'",
            scope.space_id
        )).await.unwrap();
        let target_key = format!("{}:{}:{deleted}", view.note, view.key);
        assert!(
            store
                .read_entity_revision_at_cutoff(&scope, "rank", &target_key, Some(height))
                .await
                .unwrap()
                .is_some()
        );
        drop(store);
        runtime.shutdown().await.unwrap();

        let remove_projection = include_str!("../fixtures/schema-v6-remove-projection.sql");
        let old_hash = hex::decode(CANONICAL_V6_HASH).unwrap();
        let invalid_height = height.get() as i64 + 1;
        let downgrade = "UPDATE schema_meta SET schema_version=6, manifest_checksum=$1";
        let set_row_height = "UPDATE view_rank_overlays SET updated_seq=$1 WHERE space_id=$2";
        macro_rules! set_height {
            ($db:expr, $height:expr) => {
                sqlx::query(set_row_height)
                    .bind($height)
                    .bind(scope.space_id.as_str())
                    .execute(&mut $db)
                    .await
                    .unwrap()
            };
        }
        if postgres {
            let mut db = fixtures.open_raw_pg().await;
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET search_path TO {schema}")))
                .execute(&mut db)
                .await
                .unwrap();
            sqlx::raw_sql(remove_projection)
                .execute(&mut db)
                .await
                .unwrap();
            sqlx::query(downgrade)
                .bind(&old_hash)
                .execute(&mut db)
                .await
                .unwrap();
            set_height!(db, invalid_height);
            assert!(CanonicalRuntime::open(config.clone()).await.is_err());
            assert!(
                sqlx::query_scalar::<_, Option<String>>(
                    "SELECT to_regclass('projection_rank_anchors')::text"
                )
                .fetch_one(&mut db)
                .await
                .unwrap()
                .is_none()
            );
            assert_eq!(
                sqlx::query_scalar::<_, i32>("SELECT schema_version FROM schema_meta")
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                6
            );
            set_height!(db, height.get() as i64);
        } else {
            let mut db = temp.open_raw_sqlite().await;
            sqlx::raw_sql(remove_projection)
                .execute(&mut db)
                .await
                .unwrap();
            sqlx::query(downgrade)
                .bind(&old_hash)
                .execute(&mut db)
                .await
                .unwrap();
            set_height!(db, invalid_height);
            assert!(CanonicalRuntime::open(config.clone()).await.is_err());
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name='projection_rank_anchors'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT schema_version FROM schema_meta")
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                6
            );
            set_height!(db, height.get() as i64);
        }

        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let projection = maintenance_ctx(ServicePurpose::Projection);
        let page = PageLimit::new(10).unwrap();
        assert_validation_err(
            &store
                .read_projection_overlays_page(&projection, &scope, before, None, page)
                .await,
            ValidationReason::CursorStale,
        );
        let snapshot = store
            .read_projection_overlays_page(&projection, &scope, height, None, page)
            .await
            .unwrap();
        assert_eq!(snapshot.rows.len(), 1);
        assert_eq!(snapshot.rows[0].metadata.target_note_id, surviving);
        assert_eq!(Some(&snapshot.rows[0].revision_id), retained_rank.as_ref());
        assert_eq!(store.execute_diagnostic_read_sql_for_test(None, &format!(
            "SELECT COUNT(*) FROM projection_rank_anchors WHERE space_id = '{}' AND anchor_seq = 0", empty.scope.space_id
        )).await.unwrap(), 1);

        let rebound = HistoryScope {
            space_id: scope.space_id,
            incarnation: sample_incarnation(69),
        };
        store
            .restore_cursors(
                maintenance_ctx(ServicePurpose::Restore),
                vec![
                    ChangeCursor {
                        scope: rebound.clone(),
                        after: height,
                    },
                    ChangeCursor {
                        scope: HistoryScope {
                            space_id: empty.scope.space_id,
                            incarnation: sample_incarnation(70),
                        },
                        after: SpaceSeq::ZERO,
                    },
                ],
            )
            .await
            .unwrap();
        let restored = store
            .read_projection_overlays_page(&projection, &rebound, height, None, page)
            .await
            .unwrap();
        assert_eq!(restored.rows, snapshot.rows);

        let purged = store
            .delete_note(
                owner_ctx(&rebound, owner.clone()),
                next_mutation(
                    &rebound,
                    &owner,
                    DeleteNote {
                        note: view.note,
                        disposition: DeleteDisposition::Purge,
                    },
                ),
            )
            .await
            .unwrap();
        assert!(
            store
                .read_projection_overlays_page(
                    &projection,
                    &rebound,
                    purged.receipt.seq(),
                    None,
                    page
                )
                .await
                .unwrap()
                .rows
                .is_empty()
        );
        assert_eq!(
            store
                .execute_diagnostic_read_sql_for_test(
                    None,
                    "SELECT COUNT(*) FROM projection_rank_anchor_rows"
                )
                .await
                .unwrap(),
            0
        );
        runtime.shutdown().await.unwrap();
    }
    fixtures.drop_pg_schema(&schema).await;
}
