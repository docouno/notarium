#![forbid(unsafe_code)]

mod support;

use std::{
    fs,
    path::Path,
    process::{Child, Command},
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CollabRoomState, S3BucketModePolicy,
    blobs::s3::admin_ensure_bucket,
};
use notarium_collab::CollabHub;
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::PortError,
    ids::*,
    patch::CarrierEditOrigin,
    ports::{NoteRevision, NoteWritePort, RollbackAgentRun, ServicePurpose},
};
use support::*;
use yrs::{
    Doc, GetString, Transact, Update,
    sync::{Message, SyncMessage},
    updates::decoder::Decode,
};

const CHILD_ROOT: &str = "NOTARIUM_COLLAB_CRASH_CHILD_ROOT";
const CHILD_SCHEMA: &str = "NOTARIUM_COLLAB_CRASH_CHILD_SCHEMA";
const CHILD_BUCKET: &str = "NOTARIUM_COLLAB_CRASH_CHILD_BUCKET";
const INITIAL: &str = "# Original seed 🚀\n";
const APPEND: &str = "Durable Cyrillic: проверка 🧪\n";
const PENDING: &str = "Draft.\n\n```nota\ntype: table # retained comment\n";
const AGENT_BASE: &str = "Before the agent.\n";
const AGENT_CHANGE: &str = "Written by the agent.\n";
const HUMAN_CHANGE: &str = "Written by a peer before the crash. 🛠\n";
const DIRTY_FIRST: u8 = 110;
const CLEAN: u8 = 115;

fn agent_run() -> AgentRunId {
    AgentRunId::from_bytes([123; 16])
}

struct CrashChild(Child);

impl Drop for CrashChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn configuration(root: &Path, pg: Option<(&StorageTestFixtures, &str, &str)>) -> CanonicalConfig {
    let installation = InstallationId::from_bytes([17; 16]);
    match pg {
        None => CanonicalConfig::local_default(installation, DataRoot::new(root)),
        Some((fixtures, schema, bucket)) => fixtures.pg_s3_config(
            installation,
            schema,
            fixtures.s3_config(bucket, S3BucketModePolicy::DetectFromBucket),
        ),
    }
}

// Spawn the same integration-test executable in an isolated child. The child
// writes its witness only after receiving the ACK and observing that the
// canonical Markdown still contains the seed. The parent kills it with SIGKILL.
#[tokio::test]
async fn crash_child() {
    let Some(root) = std::env::var_os(CHILD_ROOT) else {
        return;
    };
    let root = Path::new(&root);
    let schema = std::env::var(CHILD_SCHEMA).ok();
    let bucket = std::env::var(CHILD_BUCKET).ok();
    let fixtures = schema
        .as_ref()
        .map(|_| StorageTestFixtures::load_required());
    let pg = fixtures
        .as_ref()
        .zip(schema.as_deref())
        .zip(bucket.as_deref())
        .map(|((fixtures, schema), bucket)| (fixtures, schema, bucket));
    let (store, _runtime) = CanonicalRuntime::open(configuration(root, pg))
        .await
        .unwrap();
    let scope = test_scope();
    create_space(&store, &scope).await;
    let owner = owner_context(&scope);
    let initial = create_note(&store, &owner, 105, INITIAL, None).await;
    let structural = create_note(&store, &owner, 106, "Draft.\n", None).await;

    let no_checkpoint = Duration::from_secs(3_600);
    let mut cfg = notarium_collab::CollabConfig::default();
    cfg.idle_checkpoint = no_checkpoint;
    cfg.periodic_checkpoint = no_checkpoint;
    cfg.idle_unload = no_checkpoint;
    let hub = CollabHub::new(store.clone(), cfg).unwrap();
    let (mut writer, _) = synced_client(&hub, &owner, &initial.note, 210).await;
    assert_eq!(writer.text(), INITIAL);
    writer.send_update(&writer.append(APPEND)).await;
    let ack = writer.ack().await;
    let recorded = store
        .read_collab_session(None, &scope, &initial.note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ack.room_update_seq, 1);
    assert_eq!(recorded.session.carrier_rev_id, initial.revision);
    assert!(recorded.session.yrs_snapshot_blob.is_some());
    assert!(recorded.session.carrier_dirty);
    assert_eq!(recorded.updates.len(), 1);
    assert_eq!(recorded.updates[0].update_seq, ack.room_update_seq);
    assert_eq!(note_head(&store, &owner, &initial.note).await.1, INITIAL);

    let (mut author, _) = synced_client(&hub, &owner, &structural.note, 212).await;
    let (mut observer, _) = synced_client(&hub, &owner, &structural.note, 213).await;
    author
        .send_update(&author.append("\n```nota\ntype: table # retained comment\n"))
        .await;
    author.ack().await;
    observer
        .until(|message| matches!(message, Message::Sync(SyncMessage::Update(_))))
        .await;
    assert_eq!(author.text(), PENDING);
    assert_eq!(observer.text(), PENDING);

    author.send_update(&author.append("```\n")).await;
    author.ack().await;
    let normalized = author.text();
    let body = notarium_syntax::carrier::Carrier::scan(&normalized)
        .unwrap()
        .body;
    let markdown = notarium_syntax::markdown::analyze(&normalized, body).unwrap();
    let views =
        notarium_syntax::nota::analyze(&normalized, body, &structural.note, &markdown, false)
            .unwrap()
            .blocks;
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].state, notarium_core::document::ViewState::Ready);
    assert!(views[0].id.is_some());
    assert!(normalized.contains("# retained comment"));
    observer.sync().await;
    assert_eq!(observer.text(), normalized);

    // Six agent-edited notes outlast their room owner. Five contain confirmed
    // human changes and one clean room still has a prior agent revision.
    let mut rollback_peers = Vec::new();
    let agent = agent_context(&owner, &agent_run());
    for seed in DIRTY_FIRST..=CLEAN {
        let note = create_note(&store, &owner, seed, AGENT_BASE, None)
            .await
            .note;
        store
            .edit_note(
                agent.clone(),
                edit(
                    &agent,
                    &note,
                    AGENT_BASE,
                    CarrierEditOrigin::Body,
                    0,
                    AGENT_BASE.len(),
                    AGENT_CHANGE,
                ),
            )
            .await
            .unwrap();
        if seed == CLEAN {
            let mut warm_cfg = notarium_collab::CollabConfig::default();
            warm_cfg.idle_checkpoint = Duration::from_millis(20);
            warm_cfg.idle_unload = Duration::from_millis(50);
            let warm = CollabHub::new(store.clone(), warm_cfg).unwrap();
            let (warming_peer, _) = synced_client(&warm, &owner, &note, 216).await;
            drop(warming_peer);
            wait_until(async || warm.active_room_count() == 0).await;
        }
        let (mut peer, _) = synced_client(&hub, &owner, &note, u64::from(seed)).await;
        if seed != CLEAN {
            peer.send_update(&peer.append(HUMAN_CHANGE)).await;
            peer.ack().await;
        }
        rollback_peers.push(peer);
    }
    assert_eq!(hub.active_room_count(), 8);
    fs::write(root.join("crash-structural-expected"), normalized).unwrap();
    fs::write(root.join("crash-acknowledged"), b"durable").unwrap();
    std::future::pending::<()>().await;
    drop(rollback_peers);
}

async fn abrupt_restart(pg: Option<(&StorageTestFixtures, &str, &str)>) {
    let root = TempDataRoot::new("collab-crash");
    let path = root.path();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "crash_child", "--nocapture"])
        .env(CHILD_ROOT, path);
    if let Some((_, schema, bucket)) = pg {
        command.env(CHILD_SCHEMA, schema).env(CHILD_BUCKET, bucket);
    } else {
        command.env_remove(CHILD_SCHEMA).env_remove(CHILD_BUCKET);
    }
    let mut child = CrashChild(command.spawn().unwrap());
    tokio::time::timeout(Duration::from_secs(30), async {
        while !path.join("crash-acknowledged").exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("collaboration subprocess exited before the durable ACK: {status}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("durable ACK in collaboration child");
    child.0.kill().unwrap();
    let killed = child.0.wait().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(killed.signal(), Some(9));
    }
    #[cfg(not(unix))]
    assert!(!killed.success());

    let (store, runtime) = CanonicalRuntime::open(configuration(path, pg))
        .await
        .unwrap();
    let scope = test_scope();
    if pg.is_some() {
        store
            .advance_space_lease(
                &maintenance_ctx(ServicePurpose::Revocation),
                &scope,
                LeaseEpoch::new(2).unwrap(),
            )
            .await
            .unwrap();
    }

    let first = NoteId::from_bytes([105; 16]);
    let structural = NoteId::from_bytes([106; 16]);
    let fenced = store
        .read_collab_session(None, &scope, &first)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fenced.session.room_state, CollabRoomState::Fenced);
    assert!(fenced.session.carrier_dirty);
    assert_eq!(fenced.updates.len(), 1);
    let seed_doc = Doc::new();
    let seed_body = seed_doc.get_or_insert_text("body");
    seed_doc
        .transact_mut()
        .apply_update(Update::decode_v1(&fenced.session.yrs_snapshot_blob.unwrap()).unwrap())
        .unwrap();
    assert_eq!(seed_body.get_string(&seed_doc.transact()), INITIAL);

    let hub = CollabHub::new(store.clone(), Default::default()).unwrap();
    hub.register().unwrap();
    let owner = owner_context(&scope);
    let mut rollback_heads = Vec::new();
    for seed in DIRTY_FIRST..=CLEAN {
        let note = NoteId::from_bytes([seed; 16]);
        let saved = store
            .read_collab_session(None, &scope, &note)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.session.room_state, CollabRoomState::Fenced);
        assert_eq!(saved.session.carrier_dirty, seed != CLEAN);
        rollback_heads.push(NoteRevision {
            note,
            revision: saved.session.carrier_rev_id,
        });
    }
    let run = agent_run();
    let run_revision = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
        .await
        .unwrap()
        .unwrap();
    let rollback = mutation(
        &owner,
        RollbackAgentRun {
            run,
            expected_run_revision: run_revision,
            expected_entities: rollback_heads,
            associated_board_expectations: Vec::new(),
        },
    );
    let committed = store
        .rollback_agent_run(owner.clone(), rollback.clone())
        .await
        .unwrap();
    let replay = store
        .rollback_agent_run(owner.clone(), rollback)
        .await
        .unwrap();
    assert_eq!(committed.receipt, replay.receipt);
    assert!(committed.value.skipped_room_active.is_empty());
    assert_eq!(committed.value.restored.len(), 1);
    assert_eq!(
        committed.value.restored[0].note,
        NoteId::from_bytes([CLEAN; 16])
    );
    assert_eq!(
        committed.value.skipped_manual_edits,
        (DIRTY_FIRST..CLEAN)
            .map(|seed| NoteId::from_bytes([seed; 16]))
            .collect::<Vec<_>>(),
    );
    for seed in DIRTY_FIRST..=CLEAN {
        let note = NoteId::from_bytes([seed; 16]);
        let expected = if seed == CLEAN {
            AGENT_BASE.to_owned()
        } else {
            format!("{AGENT_CHANGE}{HUMAN_CHANGE}")
        };
        assert_eq!(note_head(&store, &owner, &note).await.1, expected);
    }

    // A direct stale edit must recover the WAL before the conflict is
    // reported. The caller can retry from the newly revealed head.
    let (old_revision, _) = note_head(&store, &owner, &first).await;
    let stale = edit(
        &owner,
        &first,
        INITIAL,
        CarrierEditOrigin::Body,
        INITIAL.len(),
        INITIAL.len(),
        "Stale direct edit.\n",
    );
    let conflict = store.edit_note(owner.clone(), stale).await;
    let (recovered_revision, recovered_carrier) = note_head(&store, &owner, &first).await;
    assert_ne!(old_revision, recovered_revision);
    assert!(matches!(
        conflict,
        Err(PortError::Domain(DomainError::RevisionConflict { current, .. }))
            if current == recovered_revision
    ));
    assert_eq!(recovered_carrier, format!("{INITIAL}{APPEND}"));
    assert_eq!(
        hub.recover_fenced_rooms(&maintenance_ctx(ServicePurpose::CollabRecovery), &scope)
            .await
            .unwrap(),
        1,
    );
    assert_eq!(hub.active_room_count(), 0);
    let expected_structural = fs::read_to_string(path.join("crash-structural-expected")).unwrap();
    assert_eq!(
        note_head(&store, &owner, &first).await.1,
        format!("{INITIAL}{APPEND}")
    );
    assert_eq!(
        note_head(&store, &owner, &structural).await.1,
        expected_structural
    );
    for note in [&first, &structural] {
        let settled = store
            .read_collab_session(None, &scope, note)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settled.session.room_state, CollabRoomState::Closed);
        assert!(!settled.session.carrier_dirty);
        assert!(settled.updates.is_empty());
    }

    let (writer, _) = synced_client(&hub, &owner, &first, 214).await;
    assert_eq!(writer.text(), format!("{INITIAL}{APPEND}"));
    let (reader, _) = synced_client(&hub, &owner, &structural, 215).await;
    assert_eq!(reader.text(), expected_structural);
    drop((writer, reader, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_sigkill_before_first_checkpoint() {
    abrupt_restart(None).await;
}

#[tokio::test]
async fn postgres_minio_sigkill_before_first_checkpoint() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("collab-crash");
    let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    abrupt_restart(Some((&fixtures, &schema, &bucket))).await;
    fixtures.drop_pg_schema(&schema).await;
}
