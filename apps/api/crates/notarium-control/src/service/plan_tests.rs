use super::{
    abilities::mutations::{
        ABILITY_PREFS_MOVE_DELETE_SQLITE_SQL, ABILITY_PREFS_MOVE_UPDATE_SQLITE_SQL,
        ABILITY_TRAIL_BY_DEST_SQLITE_SQL,
    },
    context_state::{
        selection::{
            BOOTSTRAP_FAVORITES_AFTER_SQLITE_SQL, BOOTSTRAP_FAVORITES_FIRST_SQLITE_SQL,
            BOOTSTRAP_SCOPE_PINS_SQLITE_SQL, BOOTSTRAP_SCOPE_SETS_SQLITE_SQL,
        },
        sets::LIST_CONTEXT_SETS_PROJECT_SQLITE_SQL,
    },
    episodes::OPEN_EPISODES_BY_NAME_SQLITE_SQL,
    provider::{
        admission::CALL_RUN_EPOCHS_SQLITE_SQL,
        offers::{LIST_OFFERS_PROJECT_PINNED_SQLITE_SQL, LIST_OFFERS_SPACE_SQLITE_SQL},
        selection::LIST_PROVIDER_PROJECT_TARGETS_SQLITE_SQL,
    },
    schedules::queries::{
        DUE_SCHEDULES_SQLITE_SQL, EXPIRED_SCHEDULE_RUNS_SQLITE_SQL, LIST_SCHEDULES_LIVE_SQLITE_SQL,
        LIST_SCHEDULES_PROJECT_LIVE_SQLITE_SQL,
    },
    spaces::WHOAMI_PROVIDER_SQLITE_SQL,
    telemetry::cleanup::{
        DELETE_SCHEDULE_RUNS_RETENTION_SQLITE_SQL, DELETE_SCHEDULES_RETENTION_SQLITE_SQL,
    },
};
use crate::store::ControlStore;
use notarium_core::{
    epoch::DataRoot,
    ids::{
        AbilityId, AgentRunId, CredentialId, EpisodeId, PrincipalId, ProviderResourceId,
        ScheduleId, SpaceId,
    },
};
use sqlx::{Connection, Row};
use std::path::PathBuf;

fn scratch() -> PathBuf {
    let base = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!(
        "control-tests/plan-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("v1")).unwrap();
    dir
}

fn check_plan(phase: &str, name: &str, expected_idx: &str, rows: &[sqlx::sqlite::SqliteRow]) {
    let joined = rows
        .iter()
        .map(|r| r.get::<String, _>(3))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        joined.contains(expected_idx),
        "{phase} {name} must use {expected_idx}, got:\n{joined}"
    );
    assert!(
        !joined.contains("SCAN ") && !joined.contains("TEMP B-TREE") && !joined.contains("ANY("),
        "{phase} {name} must avoid table scans, temp B-trees, and skip-scans, got:\n{joined}"
    );
}

#[tokio::test]
async fn sqlite_hot_control_queries_use_indexes_before_and_after_analyze() {
    let root = scratch();
    let sqlite = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
    sqlite.close().await;
    let mut conn = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        root.join("v1/control.sqlite").display()
    ))
    .await
    .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut conn)
        .await
        .unwrap();

    let first_uid = PrincipalId::from_bytes([0x10; 16]).to_string();
    let first_space = SpaceId::from_bytes([0x40; 16]).to_string();
    let first_run = AgentRunId::from_bytes([0x80; 16]).to_string();
    let first_ab = AbilityId::from_bytes([0x90; 16]).to_string();

    // Seed multi-tenant rows (> 200 schedule/run/call rows) so SQLite's
    // post-ANALYZE planner has realistic cardinality statistics.
    for u in 0..8u8 {
        let uid = PrincipalId::from_bytes([0x10 + u; 16]).to_string();
        sqlx::query(
            "INSERT INTO users(user_id,username,display_name,created_at) VALUES (?1,?2,?2,1)",
        )
        .bind(&uid)
        .bind(format!("user-{u}"))
        .execute(&mut conn)
        .await
        .unwrap();
        let cred_id = CredentialId::from_bytes([0x20 + u; 16]).to_string();
        sqlx::query(
            "INSERT INTO credentials(id,owner_id,name,kind,secret,injection,consent_epoch,runtime_epoch,revision,created_at,updated_at)
             VALUES (?1,?2,'k','provider-header-v1','cipher','header',1,1,1,1,1)",
        )
        .bind(&cred_id)
        .bind(&uid)
        .execute(&mut conn)
        .await
        .unwrap();
        let res_id = ProviderResourceId::from_bytes([0x30 + u; 16]).to_string();
        sqlx::query(
            "INSERT INTO provider_resources(id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,timeouts,revision)
             VALUES (?1,?2,?3,'openai','https://api.openai.com/v1','{}',?4,1,1,'{}',1)",
        )
        .bind(&res_id)
        .bind(&uid)
        .bind(format!("res-{u}"))
        .bind(&cred_id)
        .execute(&mut conn)
        .await
        .unwrap();
        let space_id = SpaceId::from_bytes([0x40 + u; 16]).to_string();
        for m in 0..4u8 {
            let (kind, dim) = if m == 0 {
                ("completion", None)
            } else {
                ("embedding", Some(64i64))
            };
            sqlx::query(
                "INSERT INTO provider_models(resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision)
                 VALUES (?1,?2,?3,?4,'conservative_v1',4096,1024,?5,'{}',1)",
            )
            .bind(&res_id)
            .bind(format!("mod_{u:02x}_{m:02x}"))
            .bind(format!("wire-{m}"))
            .bind(kind)
            .bind(dim)
            .execute(&mut conn)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO provider_attachments(id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision)
             VALUES (?1,?2,'personal',?3,?4,NULL,1,1,'approved','{}',NULL,1)",
        )
        .bind(format!("att_pers_{u:02x}"))
        .bind(&res_id)
        .bind(&uid)
        .bind(&space_id)
        .execute(&mut conn)
        .await
        .unwrap();
        for a in 0..6u8 {
            let att_id = format!("att_{u:02x}_{a:02x}");
            let state = if a % 2 == 0 { "approved" } else { "pending" };
            let (target_kind, target_project) = if a == 0 {
                ("space", None)
            } else {
                ("project", Some(format!("fld_{u:02x}_{a:02x}")))
            };
            sqlx::query(
                "INSERT INTO provider_attachments(id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision)
                 VALUES (?1,?2,?3,NULL,?4,?5,1,1,?6,'{}',NULL,1)",
            )
            .bind(&att_id)
            .bind(&res_id)
            .bind(target_kind)
            .bind(&space_id)
            .bind(target_project)
            .bind(state)
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for e in 0..16u8 {
            let ep_id =
                EpisodeId::from_bytes([0x60 + u, e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
                    .to_string();
            let lifecycle = if e < 14 { "closed" } else { "active" };
            sqlx::query(
                "INSERT INTO agent_episodes(episode_id,owner_id,name,lifecycle,revision,created_at,last_seen_at)
                 VALUES (?1,?2,'daily',?3,1,1,?4)",
            )
            .bind(&ep_id)
            .bind(&uid)
            .bind(lifecycle)
            .bind(100 + i64::from(e))
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for s in 0..32u8 {
            let sched_id =
                ScheduleId::from_bytes([0x70 + u, s, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
                    .to_string();
            let deleted_at = (s >= 16).then_some(500 + i64::from(s));
            let next_slot = (s < 16).then_some(1000 + i64::from(s));
            sqlx::query(
                "INSERT INTO agent_schedules(schedule_id,owner_id,space_id,project_folder_id,title,init_prompt,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,config_revision,revision,created_at,updated_at)
                 VALUES (?1,?2,?3,NULL,'k','p','0 * * * *','UTC','r',NULL,1,'{}','coalesce_latest',?4,?5,1,1,1,1)",
            )
            .bind(&sched_id)
            .bind(&uid)
            .bind(&space_id)
            .bind(next_slot)
            .bind(deleted_at)
            .execute(&mut conn)
            .await
            .unwrap();
            for r in 0..4u8 {
                let run_id =
                    AgentRunId::from_bytes([0x80 + u, s, r, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
                        .to_string();
                let (status, finished_at) = match r {
                    0 => ("claimed", None),
                    1 => ("running", None),
                    2 => ("succeeded", Some(2000 + i64::from(s))),
                    _ => ("failed", Some(2100 + i64::from(s))),
                };
                sqlx::query(
                    "INSERT INTO agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at)
                     VALUES (?1,?2,?3,1,?4,1,NULL,?5,10,?6,0,1,0,'scope',5000)",
                )
                .bind(&run_id)
                .bind(&sched_id)
                .bind(100 + i64::from(r))
                .bind(&[0xAAu8; 32][..])
                .bind(status)
                .bind(finished_at)
                .execute(&mut conn)
                .await
                .unwrap();
            }
        }
        for c in 0..32u8 {
            let call_id = format!("call_{u:02x}_{c:02x}");
            let run_id = AgentRunId::from_bytes([0x80 + (c % 4); 16]).to_string();
            sqlx::query(
                "INSERT INTO provider_call_log(call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at)
                 VALUES (?1,?2,?2,?3,'sc',?4,?5,?6,?7,'{}','[]',NULL,1,'[]','settled','completed','exact',1,1,NULL,NULL,10,20)",
            )
            .bind(&call_id)
            .bind(&uid)
            .bind(&run_id)
            .bind(format!("ik_{u:02x}_{c:02x}"))
            .bind(&[0xBBu8; 32][..])
            .bind(&res_id)
            .bind(&cred_id)
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for a in 0..16u8 {
            let ab_id = AbilityId::from_bytes([0x90 + (a % 4); 16]).to_string();
            let dst_ab =
                AbilityId::from_bytes([0xA0 + u, a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
                    .to_string();
            let src_pl = format!(r#"{{"space":"{space_id}","idx":{a}}}"#);
            let dst_pl = format!(r#"{{"space":"{space_id}","dst":{a}}}"#);
            sqlx::query(
                "INSERT INTO ability_placement_trail(source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at)
                 VALUES (?1,?2,?3,?4,'m',1)",
            )
            .bind(&src_pl)
            .bind(&ab_id)
            .bind(&dst_pl)
            .bind(&dst_ab)
            .execute(&mut conn)
            .await
            .unwrap();
            sqlx::query(
                "INSERT OR IGNORE INTO ability_preferences(owner_id,ability_id,placement,enabled,revision)
                 VALUES (?1,?2,?3,1,1)",
            )
            .bind(&uid)
            .bind(&ab_id)
            .bind(&src_pl)
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for f in 0..32u8 {
            let kind = if f % 2 == 0 { "note" } else { "folder" };
            let eid = format!("ent_{u:02x}_{f:02x}");
            sqlx::query(
                "INSERT INTO favorites(owner_id,space_id,entity_kind,entity_id,rank,created_at)
                 VALUES (?1,?2,?3,?4,?5,1)",
            )
            .bind(&uid)
            .bind(&space_id)
            .bind(kind)
            .bind(&eid)
            .bind(i64::from(f))
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for p in 0..16u8 {
            let nid = format!("nt_{u:02x}_{p:02x}");
            sqlx::query(
                "INSERT INTO context_scope_pins(owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at)
                 VALUES (?1,'space',?2,?2,?2,?3,1,1)",
            )
            .bind(&uid)
            .bind(&space_id)
            .bind(&nid)
            .execute(&mut conn)
            .await
            .unwrap();
            let set_id = format!("set_{u:02x}_{p:02x}");
            sqlx::query(
                "INSERT INTO context_sets(set_id,owner_id,home_space,name,note_refs,revision,created_at)
                 VALUES (?1,?2,?3,'bundle','[]',1,1)",
            )
            .bind(&set_id)
            .bind(&uid)
            .bind(&space_id)
            .execute(&mut conn)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO context_set_attachments(set_id,target_kind,target_id,target_space,owner_id,revision)
                 VALUES (?1,'space',?2,?2,?3,1)",
            )
            .bind(&set_id)
            .bind(&space_id)
            .bind(&uid)
            .execute(&mut conn)
            .await
            .unwrap();
            let note_ref_json = format!(r#"{{"space_id":"{space_id}","note_id":"{nid}"}}"#);
            sqlx::query(
                "INSERT INTO context_order(owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision)
                 VALUES (?1,'space',?2,?2,'note',?3,?4,1)",
            )
            .bind(&uid)
            .bind(&space_id)
            .bind(&note_ref_json)
            .bind(i64::from(p))
            .execute(&mut conn)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO context_order(owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision)
                 VALUES (?1,'space',?2,?2,'set',?3,?4,1)",
            )
            .bind(&uid)
            .bind(&space_id)
            .bind(&set_id)
            .bind(i64::from(p) + 100)
            .execute(&mut conn)
            .await
            .unwrap();
        }
    }

    for phase in ["pre-ANALYZE", "post-ANALYZE"] {
        if phase == "post-ANALYZE" {
            sqlx::query("ANALYZE").execute(&mut conn).await.unwrap();
        }
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {DUE_SCHEDULES_SQLITE_SQL}"
        )))
        .bind(9999i64)
        .bind(i64::MIN)
        .bind("")
        .bind(65i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(phase, "schedule_due", "USING INDEX schedule_due", &rows);

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {EXPIRED_SCHEDULE_RUNS_SQLITE_SQL}"
        )))
        .bind(9999i64)
        .bind(i64::MIN)
        .bind("")
        .bind(65i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "schedule_expired_run",
            "USING INDEX schedule_expired_run",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {DELETE_SCHEDULES_RETENTION_SQLITE_SQL}"
        )))
        .bind(9999i64)
        .bind(200i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "schedule_deleted",
            "USING COVERING INDEX schedule_deleted",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {DELETE_SCHEDULE_RUNS_RETENTION_SQLITE_SQL}"
        )))
        .bind(9999i64)
        .bind(200i64)
        .bind(2 * 86_400_000i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "schedule_run_retention",
            "USING INDEX schedule_run_retention",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {OPEN_EPISODES_BY_NAME_SQLITE_SQL}"
        )))
        .bind(&first_uid)
        .bind("daily")
        .bind("")
        .bind(64i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "episode_owner_name_open",
            "USING INDEX episode_owner_name_open",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {LIST_OFFERS_SPACE_SQLITE_SQL}"
        )))
        .bind(&first_space)
        .bind("fld_00_01")
        .bind("")
        .bind(1i64)
        .bind(65i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "list_offers_space",
            "USING INDEX attachment_target_approved_id",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {LIST_OFFERS_PROJECT_PINNED_SQLITE_SQL}"
        )))
        .bind(&first_space)
        .bind("fld_00_01")
        .bind("")
        .bind(1i64)
        .bind(65i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "list_offers_project_pinned",
            "USING INDEX attachment_target_project_approved_id",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {CALL_RUN_EPOCHS_SQLITE_SQL}"
        )))
        .bind(&first_run)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(phase, "call_run", "USING INDEX call_run", &rows);

        let first_dst_ab =
            AbilityId::from_bytes([0xA0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]).to_string();
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {ABILITY_TRAIL_BY_DEST_SQLITE_SQL}"
        )))
        .bind(format!(r#"{{"space":"{first_space}","dst":1}}"#))
        .bind(&first_dst_ab)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "ability_trail_destination",
            "USING INDEX ability_trail_destination",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {ABILITY_PREFS_MOVE_DELETE_SQLITE_SQL}"
        )))
        .bind(format!(r#"{{"space":"{first_space}","idx":0}}"#))
        .bind(&first_ab)
        .bind(format!(r#"{{"space":"{first_space}","dst":1}}"#))
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "ability_preference_placement_delete",
            "USING COVERING INDEX ability_preference_placement",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {ABILITY_PREFS_MOVE_UPDATE_SQLITE_SQL}"
        )))
        .bind(format!(r#"{{"space":"{first_space}","dst":1}}"#))
        .bind(format!(r#"{{"space":"{first_space}","idx":0}}"#))
        .bind(&first_ab)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "ability_preference_placement_update",
            "USING INDEX ability_preference_placement",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {BOOTSTRAP_FAVORITES_FIRST_SQLITE_SQL}"
        )))
        .bind(&first_uid)
        .bind(32i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "bootstrap_favorites_first",
            "USING COVERING INDEX favorite_note_order",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {BOOTSTRAP_FAVORITES_AFTER_SQLITE_SQL}"
        )))
        .bind(&first_uid)
        .bind(4i64)
        .bind(&first_space)
        .bind("ent_00_04")
        .bind(32i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "bootstrap_favorites_after",
            "USING COVERING INDEX favorite_note_order",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {BOOTSTRAP_SCOPE_PINS_SQLITE_SQL}"
        )))
        .bind("space")
        .bind(&first_space)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "bootstrap_scope_pins_pin",
            "USING COVERING INDEX context_pin_target",
            &rows,
        );
        check_plan(
            phase,
            "bootstrap_scope_pins_order",
            "USING COVERING INDEX context_order_lookup",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {BOOTSTRAP_SCOPE_SETS_SQLITE_SQL}"
        )))
        .bind("space")
        .bind(&first_space)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "bootstrap_scope_sets_att",
            "USING INDEX context_attachment_target",
            &rows,
        );
        check_plan(
            phase,
            "bootstrap_scope_sets_order",
            "USING COVERING INDEX context_order_lookup",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {}",
            include_str!("context_state/entries.sqlite.sql")
        )))
        .bind("space")
        .bind(&first_space)
        .bind(0i64)
        .bind("")
        .bind("")
        .bind("")
        .bind(32i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        let entry_details: Vec<String> = rows.iter().map(|r| r.get::<String, _>(3)).collect();
        let entry_joined = entry_details.join("\n");
        for expected in [
            "SEARCH a USING INDEX context_attachment_target",
            "SEARCH s USING INDEX sqlite_autoindex_context_sets_1",
            "SEARCH p USING COVERING INDEX context_pin_target",
            "SEARCH o USING COVERING INDEX context_order_lookup",
        ] {
            assert!(
                entry_joined.contains(expected),
                "{phase} context_entries must include `{expected}`, got:\n{entry_joined}"
            );
        }
        assert!(
            !entry_details
                .iter()
                .any(|d| d.starts_with("SCAN ") && !d.starts_with("SCAN entries")
                    || d.contains("ANY(")),
            "{phase} context_entries must avoid base-table scans and skip-scans, got:\n{entry_joined}"
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {LIST_SCHEDULES_LIVE_SQLITE_SQL}"
        )))
        .bind(&first_uid)
        .bind(&first_space)
        .bind("")
        .bind(32i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "list_schedules_live",
            "USING INDEX schedule_owner_live",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {LIST_SCHEDULES_PROJECT_LIVE_SQLITE_SQL}"
        )))
        .bind(&first_uid)
        .bind(&first_space)
        .bind("fld_proj_01")
        .bind("")
        .bind(32i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "list_schedules_project_live",
            "USING INDEX schedule_owner_project_live",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {WHOAMI_PROVIDER_SQLITE_SQL}"
        )))
        .bind(&first_uid)
        .bind(&first_space)
        .bind(1i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "whoami_provider_personal",
            "SEARCH a USING INDEX",
            &rows,
        );

        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {LIST_CONTEXT_SETS_PROJECT_SQLITE_SQL}"
        )))
        .bind(&first_space)
        .bind("")
        .bind("{\"space_id\":\"s\",\"folder_id\":\"f\"}")
        .bind(32i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "list_context_sets_project",
            "SEARCH a USING INDEX context_attachment_target",
            &rows,
        );

        let first_res = ProviderResourceId::from_bytes([0x30; 16]).to_string();
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {LIST_PROVIDER_PROJECT_TARGETS_SQLITE_SQL}"
        )))
        .bind(&first_res)
        .bind(&first_space)
        .bind("")
        .bind(0i64)
        .bind(32i64)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        check_plan(
            phase,
            "list_provider_project_targets",
            "USING INDEX attachment_project",
            &rows,
        );
    }

    conn.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
