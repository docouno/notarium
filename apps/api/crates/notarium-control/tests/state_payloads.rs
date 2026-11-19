#[allow(dead_code)]
mod support;
use notarium_control::{
    service::AuthenticationMode,
    store::{TargetRecord, TargetTable},
};
use notarium_core::{
    auth::*,
    classes::DocClass,
    ids::*,
    model::*,
    ports::{control::*, *},
};
use std::time::Duration;
use support::*;

fn maintenance(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: budget(),
    }
}
fn audit() -> ScheduleRunContext {
    ScheduleRunContext::Scheduler(maintenance(ServicePurpose::Scheduler))
}

async fn payloads(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut f = Fixture::new(pg, "closed_payloads").await;
    let service = f.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "payloadowner".into(),
                email: None,
                display_name: "Payload owner".into(),
                password: Some(SecretString::new("closed metadata import password".into())),
            },
        )
        .await
        .unwrap();
    let token = bootstrap.session.unwrap().token;
    let ctx = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let owner = ctx.auth().principal().to_string();
    let space = bootstrap.account.personal_space.unwrap();
    let catalog = f.catalog.entries.lock().unwrap()[&space].2.clone();
    let note = NoteRef {
        space_id: space.clone(),
        note_id: NoteId::from_bytes([10; 16]),
    };
    let folder = FolderRef {
        space_id: space.clone(),
        folder_id: FolderId::from_bytes([11; 16]),
    };
    f.catalog.note_entries.lock().unwrap().insert(
        (space.clone(), note.note_id.clone()),
        CatalogNote {
            reference: note.clone(),
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: catalog.space,
                class: DocClass::UserDoc,
                project: None,
                ancestor_folders: vec![],
                folder_write_locked: false,
                ability_package: None,
            },
        },
    );
    let call_id_str = RequestId::from_bytes([20; 16]).to_string();
    let make_call = |call_id: String| TargetRecord::AgentCalls {
        call_id,
        owner_id: owner.clone(),
        principal: owner.clone(),
        agent: None,
        transport: "internal".into(),
        request_id: RequestId::from_bytes([21; 16]).to_string(),
        episode_id: None,
        tool: "list".into(),
        effect: "read".into(),
        domain: "control".into(),
        started_at: 0,
        finished_at: Some(1),
        duration_ms: Some(1),
        outcome: Some("succeeded".into()),
        reason: None,
        input_bytes: 0,
        output_bytes: Some(0),
        summaries: serde_json::to_string(&Some(ContentDigest::from_bytes([0; 32]))).unwrap(),
        fingerprint: vec![0; 32],
        projection_version: 1,
        redacted: 1,
        truncated: 0,
        detail_capture_failed: 0,
    };
    let role = AbilityRef {
        id: AbilityId::from_bytes([22; 16]),
        placement: AbilityPlacement::System,
        revision: RevisionId::from_bytes([22; 16]),
    };
    let schedule_id = ScheduleId::from_bytes([23; 16]);
    let schedule = TargetRecord::AgentSchedules {
        schedule_id: schedule_id.to_string(),
        owner_id: owner.clone(),
        space_id: space.to_string(),
        project_folder_id: None,
        title: "Imported audit".into(),
        init_prompt: "Inspect metadata".into(),
        config_revision: 0,
        cron_expr: "20 * * * * * *".into(),
        timezone: "UTC".into(),
        approved_role: serde_json::to_string_pretty(&role).unwrap(),
        paused_reason: Some("manual".into()),
        write_class_mask: 1,
        budgets: serde_json::to_string_pretty(&RunLimits::default()).unwrap(),
        misfire_policy: "coalesce_latest".into(),
        approved_skills: "[]".into(),
        next_slot_utc_ms: Some(1_700_000_000_000),
        deleted_at: None,
        revision: 0,
        created_at: 0,
        updated_at: 0,
    };
    let base_history = serde_json::to_string_pretty(&catalog.history).unwrap();
    let make_run =
        |run_id: String, slot_utc_ms: i64, reserved_next_slot: i64, history_scope: String| {
            TargetRecord::AgentScheduleRuns {
                run_id,
                schedule_id: schedule_id.to_string(),
                slot_utc_ms,
                lease_epoch: 1,
                claim_request_hash: vec![0; 32],
                owner_auth_version: 0,
                config_revision: 0,
                admission_epoch: 0,
                history_scope,
                expires_at: 300_000,
                claimed_schedule_revision: 0,
                approved_skills: "[]".into(),
                keeper_log_id: None,
                keeper_project_folder_id: None,
                reserved_next_slot: Some(reserved_next_slot),
                status: "claimed".into(),
                started_at: 0,
                finished_at: None,
                safe_result: None,
            }
        };
    // The audit type supports the complete core UTC range, independent of a
    // schedule's currently configured cron expression.
    let boundaries = [
        (-62_167_219_200_000, -62_167_219_199_000),
        (253_402_300_798_000, 253_402_300_799_000),
    ];
    let mut valid_runs = vec![(
        AgentRunId::from_bytes([24; 16]).to_string(),
        1_700_000_000_000_i64,
        1_700_000_001_000_i64,
    )];
    for (i, (slot, next)) in boundaries.into_iter().enumerate() {
        valid_runs.push((
            AgentRunId::from_bytes([25 + i as u8; 16]).to_string(),
            slot,
            next,
        ));
    }
    let detail = TargetRecord::AgentCallDetails {
        call_id: call_id_str.clone(),
        payload: serde_json::to_string_pretty(&AgentCallDetail {
            resources: vec![TelemetryResource::Note(note.clone())],
            counters: vec![],
            steps: vec![],
        })
        .unwrap(),
        created_at: 0,
        expires_at: 1_800_000_000_000,
    };
    let make_retrieval = |retrieval_id: String, hit_refs: String| TargetRecord::AgentRetrievals {
        retrieval_id,
        owner_id: owner.clone(),
        principal: owner.clone(),
        agent: None,
        call_id: None,
        tool: "search".into(),
        query_summary: "\"exact\"".into(),
        filters: serde_json::to_string(&ContentDigest::from_bytes([0; 32])).unwrap(),
        hit_refs,
        result_count: 1,
        top_score: None,
        created_at: 0,
    };
    f.observer
        .execute("UPDATE v1_storage_epoch SET state='migrating' WHERE singleton=1")
        .await;
    let mut seed = vec![
        make_call(call_id_str.clone()),
        detail,
        make_retrieval(
            RequestId::from_bytes([27; 16]).to_string(),
            serde_json::to_string_pretty(&vec![note.clone()]).unwrap(),
        ),
        schedule,
    ];
    seed.extend(
        valid_runs.iter().map(|(run_id, slot, next)| {
            make_run(run_id.clone(), *slot, *next, base_history.clone())
        }),
    );
    f.store
        .import_target_batch(maintenance(ServicePurpose::Restore), &seed)
        .await
        .unwrap();

    let mut cases: Vec<(&str, Vec<TargetRecord>, TargetRecord)> = vec![];
    for (i, resource) in [
        serde_json::to_value(&note).unwrap(),
        serde_json::to_value(&folder).unwrap(),
    ]
    .into_iter()
    .enumerate()
    {
        let mut reference = resource;
        reference["untyped_payload"] = serde_json::json!("synthetic-extra-field");
        let parent_id = RequestId::from_bytes([30 + i as u8; 16]).to_string();
        let mut tagged = serde_json::Map::new();
        tagged.insert(if i == 0 { "Note" } else { "Folder" }.into(), reference);
        let payload = serde_json::json!({"resources":[tagged],"counters":[],"steps":[]});
        cases.push((
            "nested telemetry resource",
            vec![make_call(parent_id.clone())],
            TargetRecord::AgentCallDetails {
                call_id: parent_id,
                payload: payload.to_string(),
                created_at: 0,
                expires_at: 1_800_000_000_000,
            },
        ));
    }
    let mut reference = serde_json::to_value(&note).unwrap();
    reference["untyped_payload"] = serde_json::json!("synthetic-extra-field");
    let refs = serde_json::json!([reference]);
    cases.push((
        "nested retrieval reference",
        vec![],
        make_retrieval(
            RequestId::from_bytes([32; 16]).to_string(),
            refs.to_string(),
        ),
    ));
    cases.push((
        "nested context reference",
        vec![],
        TargetRecord::ContextSets {
            set_id: ContextSetId::from_bytes([33; 16]).to_string(),
            owner_id: owner.clone(),
            home_space: space.to_string(),
            name: "Typed references".into(),
            note_refs: refs.to_string(),
            revision: 0,
            created_at: 0,
        },
    ));
    let mut bad_role = serde_json::to_value(&role).unwrap();
    bad_role["untyped_payload"] = serde_json::json!("synthetic-extra-field");
    cases.push((
        "nested role reference",
        vec![],
        TargetRecord::AgentEpisodes {
            episode_id: EpisodeId::from_bytes([34; 16]).to_string(),
            owner_id: owner.clone(),
            name: None,
            parent_id: None,
            active_role: Some(bad_role.to_string()),
            project_space: None,
            project_folder: None,
            lifecycle: "active".into(),
            revision: 0,
            created_at: 0,
            last_seen_at: 0,
            closed_at: None,
            calls: 0,
        },
    ));
    let mut history = serde_json::to_value(&catalog.history).unwrap();
    history["untyped_payload"] = serde_json::json!("synthetic-extra-field");
    cases.push((
        "nested history scope",
        vec![],
        make_run(
            AgentRunId::from_bytes([35; 16]).to_string(),
            1_700_000_010_000,
            1_700_000_011_000,
            history.to_string(),
        ),
    ));
    let times = [
        (i64::MIN, i64::MIN + 1000),
        (1_700_000_002_000, i64::MAX),
        (253_402_300_800_000, 253_402_300_801_000),
        (-62_167_219_201_000, -62_167_219_200_000),
        (1_700_000_003_001, 1_700_000_004_000),
        (1_700_000_005_000, 1_700_000_006_001),
    ];
    for (i, (slot, next)) in times.into_iter().enumerate() {
        cases.push((
            "schedule slot domain",
            vec![],
            make_run(
                AgentRunId::from_bytes([40 + i as u8; 16]).to_string(),
                slot,
                next,
                base_history.clone(),
            ),
        ));
    }
    let mut accepted = vec![];
    for (i, (label, mut prefix, row)) in cases.into_iter().enumerate() {
        prefix.push(TargetRecord::Favorites {
            owner_id: owner.clone(),
            space_id: space.to_string(),
            entity_kind: "note".into(),
            entity_id: NoteId::from_bytes([100 + i as u8; 16]).to_string(),
            rank: 0,
            created_at: 0,
        });
        let mut import = f
            .store
            .begin_target_import(maintenance(ServicePurpose::Restore))
            .await
            .unwrap();
        import.append(&prefix).await.unwrap();
        if import.append(&[row]).await.is_ok() {
            import.finish().await.unwrap();
            accepted.push((i, label));
        } else {
            assert!(
                import.finish().await.is_err(),
                "a failed page cannot later commit"
            );
        }
    }
    assert!(
        accepted.is_empty(),
        "invalid target payloads committed: {accepted:?}"
    );
    assert_eq!(f.observer.count("SELECT count(*) FROM favorites").await, 0);
    assert_eq!(
        f.observer.count("SELECT count(*) FROM agent_calls").await,
        1
    );
    assert_eq!(
        f.observer
            .count("SELECT count(*) FROM agent_schedule_runs")
            .await,
        3
    );
    f.observer
        .execute("UPDATE v1_storage_epoch SET state='ready' WHERE singleton=1")
        .await;
    service
        .get_agent_call(ctx, RequestId::parse(&call_id_str).unwrap())
        .await
        .unwrap();
    for (run_id, slot_utc_ms, _) in &valid_runs {
        let id = AgentRunId::parse(run_id).unwrap();
        let receipt = service
            .get_schedule_run(audit(), schedule_id.clone(), id.clone())
            .await
            .unwrap();
        assert_eq!(receipt.slot.unix_seconds() * 1000, *slot_utc_ms);
        let result = ScheduleResult {
            schedule: schedule_id.clone(),
            run: id,
            lease: LeaseEpoch::new(1).unwrap(),
            outcome: ScheduleOutcome::Unknown,
        };
        service
            .record_schedule_result(maintenance(ServicePurpose::Scheduler), result.clone())
            .await
            .unwrap();
        service
            .record_schedule_result(maintenance(ServicePurpose::Scheduler), result)
            .await
            .unwrap();
    }
    let mut after = None;
    let mut count = 0;
    loop {
        let page = service
            .list_schedule_runs(
                audit(),
                schedule_id.clone(),
                ControlPageRequest::new(1, after).unwrap(),
            )
            .await
            .unwrap();
        count += page.items.len();
        after = page.continuation;
        if after.is_none() {
            break;
        }
    }
    assert_eq!(count, 3);
    let mut export = f
        .store
        .export_target(
            maintenance(ServicePurpose::Backup),
            BackupBudget {
                deadline: Duration::from_secs(10),
                retention: if pg {
                    BackupRetentionBudget::PostgresSnapshot {
                        max_age: Duration::from_secs(10),
                    }
                } else {
                    BackupRetentionBudget::SqliteWal {
                        max_pinned_bytes: 64 * 1024 * 1024,
                    }
                },
                max_spool_bytes: 64 * 1024 * 1024,
            },
        )
        .await
        .unwrap();
    for table in [TargetTable::AgentCallDetails, TargetTable::AgentRetrievals] {
        let page = export.page(table, None, 10).await.unwrap();
        assert_eq!(page.records.len(), 1);
        assert!(
            !serde_json::to_string(&page.records)
                .unwrap()
                .contains("synthetic-extra-field")
        );
    }
    export.close().await.unwrap();
    drop(service);
    f.close().await;
}

#[tokio::test]
async fn sqlite_closed_payloads_and_slot_boundaries() {
    payloads(false).await;
}
#[tokio::test]
async fn postgres_closed_payloads_and_slot_boundaries() {
    payloads(true).await;
}
