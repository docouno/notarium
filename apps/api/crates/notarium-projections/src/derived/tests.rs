use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use notarium_core::{
    DomainError,
    classes::DocClass,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::*,
    model::{HistoryScope, Lifecycle},
    ports::{Cancellation, PageLimit},
};
use serde::Deserialize;
use sqlx::{
    AssertSqlSafe, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};

use super::{
    CandidateLookupKey, DerivedMutation, DerivedStore, GenerationControl, GenerationDescriptor,
    LinkAddress, LinkPosition, ProjectedChatRef, ProjectedFolder, ProjectedLink, ProjectedNote,
    ProjectedNoteAlias, ProjectionWatermark, SpaceApply, StageKey, TrustedCheckpoint,
    records::encode,
    sql::{Kind, validate_schema_prefix, value},
};
use crate::links::{CandidateQuery, ResolutionIndex};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let id = random_label();
        let root = std::env::temp_dir().join(format!("notarium-derived-{id}"));
        fs::create_dir(&root).expect("isolated scratch directory");
        Self(root)
    }
    fn data(&self) -> DataRoot {
        DataRoot::new(&self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn random_label() -> String {
    let mut nonce = [0; 6];
    getrandom::fill(&mut nonce).expect("test entropy");
    hex::encode(nonce)
}

fn seq(seq: u64) -> SpaceSeq {
    SpaceSeq::new(seq).expect("test sequence")
}

fn scope(space: u8, incarnation: u8) -> HistoryScope {
    HistoryScope {
        space_id: SpaceId::from_bytes([space; 16]),
        incarnation: HistoryIncarnation::from_bytes([incarnation; 16]),
    }
}

fn root_folder() -> FolderId {
    FolderId::from_bytes([1; 16])
}

fn rev(n: u8) -> RevisionId {
    RevisionId::from_bytes([n; 16])
}

fn note_id() -> NoteId {
    NoteId::from_bytes([2; 16])
}

fn water(scope: &HistoryScope, cut: SpaceSeq) -> ProjectionWatermark {
    ProjectionWatermark {
        scope: scope.clone(),
        root_folder_id: root_folder(),
        next_dense_id: 2,
        next_dense_folder_id: 1,
        projected_seq: cut,
        snapshot_seq: SpaceSeq::ZERO,
        graph_settled_seq: SpaceSeq::ZERO,
        schema: None,
        seed_in_progress: false,
        updated_at_ms: cut.get() as i64,
    }
}

fn folder(scope: &HistoryScope, cover: Option<NoteId>) -> ProjectedFolder {
    ProjectedFolder {
        space_id: scope.space_id.clone(),
        folder_id: root_folder(),
        dense_folder_id: 0,
        parent_folder_id: None,
        slug: String::new(),
        slug_fold: String::new(),
        display_name: "Root".to_owned(),
        norm_path_prefix: Some(String::new()),
        display_path_prefix: String::new(),
        is_project: false,
        project_slug: None,
        project_folder_id: None,
        cover_note_id: cover,
        write_locked: false,
        lifecycle: Lifecycle::Active,
        head_rev_id: rev(7),
        active_note_count: 1,
    }
}

fn note(scope: &HistoryScope, title: &str, version: u8) -> ProjectedNote {
    ProjectedNote {
        space_id: scope.space_id.clone(),
        dense_id: 1,
        note_id: note_id(),
        rev_id: rev(version),
        parent_folder_id: root_folder(),
        dense_folder_id: 0,
        ability_id: None,
        slug: "note".to_owned(),
        slug_fold: "note".to_owned(),
        title: title.to_owned(),
        title_fold: title.to_lowercase(),
        preview: format!("preview {title}"),
        doc_class: DocClass::UserDoc,
        lifecycle: Lifecycle::Active,
        byte_size: 20,
        content_digest: Some(ContentDigest::from_bytes([version; 32])),
        tags_msgpack: encode(&Vec::<String>::new()).expect("encode tags"),
        view_blocks_msgpack: Vec::new(),
        created_at_sec: -1,
        created_at_nsec: 999_000_000,
        updated_at_sec: version.into(),
        updated_at_nsec: 0,
        raw_fields_msgpack: Vec::new(),
        header_diagnostic_msgpack: Vec::new(),
        evaluated_fields_msgpack: Vec::new(),
        diagnostics_msgpack: Vec::new(),
        rank_version: ContentDigest::from_bytes([version; 32]),
        has_pending_nota: false,
        has_invalid_nota: false,
    }
}

fn chat_ref(source: &HistoryScope, target: &HistoryScope, ordinal: u64) -> ProjectedChatRef {
    ProjectedChatRef {
        target_space_id: target.space_id.clone(),
        target_note_id: note_id(),
        thread_space_id: source.space_id.clone(),
        thread_id: ChatThreadId::from_bytes([3; 16]),
        entry_seq: ThreadEntrySeq::new(3).expect("entry seq"),
        source_incarnation: source.incarnation,
        target_incarnation: target.incarnation,
        source_revision: rev(11),
        ref_ordinal: ordinal,
    }
}

async fn test_replay_publication(store: &DerivedStore) {
    let history = scope(11, 12);
    let mut base = water(&history, seq(5));
    base.snapshot_seq = seq(5);
    store
        .apply(&SpaceApply {
            expected: None,
            watermark: base.clone(),
            mutations: Vec::new(),
        })
        .await
        .unwrap();

    let mut next = base.clone();
    next.projected_seq = seq(6);
    let key = StageKey {
        scope: history.clone(),
        first: seq(6),
        last: seq(6),
    };
    let slots = [b"L0S1".as_slice(), &[0; 16]].concat();
    // Rejecting a stage must not leave a replay row at a future cut.
    assert!(
        store
            .publish_staged_with_replay(&key, 1, &next, Some(seq(5)), Some(slots.clone()))
            .await
            .is_err()
    );
    assert!(
        store
            .replay_page(&base, seq(5))
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );

    // Direct single-tx apply_with_replay publishes watermark and replay slots
    // without touching projection_apply_pages.
    store
        .apply_with_replay(
            &SpaceApply {
                expected: Some(seq(5)),
                watermark: next.clone(),
                mutations: Vec::new(),
            },
            Some(slots.clone()),
        )
        .await
        .unwrap();
    let entries = store.replay_page(&next, seq(5)).await.unwrap().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].after, seq(5));
    assert_eq!(entries[0].through, seq(6));
    assert_eq!(entries[0].slots, slots);

    next.snapshot_seq = seq(6);
    store
        .apply(&SpaceApply {
            expected: Some(seq(6)),
            watermark: next.clone(),
            mutations: Vec::new(),
        })
        .await
        .unwrap();
    assert!(
        store
            .replay_page(&next, seq(5))
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
}

async fn test_trashed_and_active_folder_path_uniqueness(store: &DerivedStore) {
    let history = scope(0xd2, 0xd3);
    let trashed_id = FolderId::from_bytes([0x10; 16]);
    let active_id = FolderId::from_bytes([0x11; 16]);
    let trashed_folder = ProjectedFolder {
        folder_id: trashed_id.clone(),
        dense_folder_id: 1,
        parent_folder_id: Some(root_folder()),
        slug: "docs".to_owned(),
        slug_fold: "docs".to_owned(),
        display_name: "Docs (trashed)".to_owned(),
        norm_path_prefix: None,
        display_path_prefix: "Docs".to_owned(),
        lifecycle: Lifecycle::Trashed,
        ..folder(&history, None)
    };
    let active_folder = ProjectedFolder {
        folder_id: active_id.clone(),
        dense_folder_id: 2,
        parent_folder_id: Some(root_folder()),
        slug: "docs".to_owned(),
        slug_fold: "docs".to_owned(),
        display_name: "Docs".to_owned(),
        norm_path_prefix: Some("docs".to_owned()),
        display_path_prefix: "Docs".to_owned(),
        lifecycle: Lifecycle::Active,
        ..folder(&history, None)
    };
    let mut wm = water(&history, seq(1));
    wm.next_dense_folder_id = 3;
    store
        .apply(&SpaceApply {
            expected: None,
            watermark: wm,
            mutations: vec![
                DerivedMutation::UpsertFolder(folder(&history, None)),
                DerivedMutation::UpsertFolder(trashed_folder),
                DerivedMutation::UpsertFolder(active_folder.clone()),
            ],
        })
        .await
        .expect("trashed sibling and active folder with the same slug coexist");
    let found = store
        .folder_by_path(&history, seq(1), "docs")
        .await
        .unwrap()
        .expect("active folder resolves by path");
    assert_eq!(found.folder_id, active_id);
}

async fn test_storage(store: &DerivedStore) {
    let local = scope(1, 2);
    let source = scope(2, 3);
    let base = water(&local, seq(10));
    let witness = store.observe_seed(&local.space_id).await.unwrap();
    store
        .begin_seed(&base, witness, &Cancellation::default())
        .await
        .expect("begin seed");
    let seed = StageKey {
        scope: local.clone(),
        first: SpaceSeq::ZERO,
        last: seq(10),
    };
    let first_page = [DerivedMutation::UpsertFolder(folder(
        &local,
        Some(note_id()),
    ))];
    store
        .stage_page(&seed, 0, &first_page)
        .await
        .expect("stage folder");
    assert!(store.hydrate(&local, seq(10), &[1]).await.is_err());

    assert_eq!(
        store
            .publish_staged(&seed, 2, &base, Some(SpaceSeq::ZERO))
            .await,
        Err(super::stale()),
    );
    assert!(
        store
            .watermarks(&local.space_id)
            .await
            .unwrap()
            .unwrap()
            .seed_in_progress
    );
    store
        .stage_page(&seed, 0, &first_page)
        .await
        .expect("replay same staged page");
    let mut notes = vec![DerivedMutation::UpsertNote(Box::new(note(
        &local, "First", 10,
    )))];
    let candidate = CandidateLookupKey {
        space_id: local.space_id.clone(),
        tier: 20,
        scope_folder_dense_id: -1,
        leaf_norm_key: "earlier-name".into(),
        target_dense_id: 1,
        target_note_id: note_id(),
        created_at_sec: 0,
        created_at_nsec: 0,
    };
    notes.push(DerivedMutation::UpsertCandidate(candidate.clone()));
    for (ordinal, prefix) in ["move", "move!neighbor", "move/child", "move/child/leaf", ""]
        .into_iter()
        .enumerate()
    {
        notes.push(DerivedMutation::UpsertLink(ProjectedLink {
            space_id: local.space_id.clone(),
            src_dense_id: 1,
            link_ord: ordinal as u32,
            src_folder_id: root_folder(),
            raw_target: format!("/{prefix}/target"),
            target_kind_tag: 0,
            dir_norm_prefix: prefix.to_owned(),
            leaf_norm_key: "target".to_owned(),
            uses_relative_prefix: false,
            resolved_dense_id: None,
            resolved_tier: None,
        }));
    }
    store
        .stage_page(&seed, 1, &notes)
        .await
        .expect("stage note");
    store
        .publish_staged(&seed, 2, &base, Some(SpaceSeq::ZERO))
        .await
        .expect("publish seed");
    let rows = store.hydrate(&local, seq(10), &[1, 0, 1]).await.unwrap();
    assert_eq!(rows[0], rows[2]);
    assert_eq!(rows[0].as_ref().unwrap().title, "First");
    assert!(rows[1].is_none());
    let narrow = store
        .hydrate_current_cards(&local, seq(10), &[1, 0, 1])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(narrow[0].as_ref().unwrap().title, "First");
    assert_eq!(
        narrow[0].as_ref().unwrap().path,
        narrow[2].as_ref().unwrap().path
    );
    assert!(narrow[1].is_none());
    let prefix = LinkAddress::Prefix("move");
    let limit = PageLimit::new(2).unwrap();
    let first = store
        .link_page(&local.space_id, prefix, None, limit)
        .await
        .unwrap();
    assert_eq!(
        first.iter().map(|row| row.link_ord).collect::<Vec<_>>(),
        [0, 2]
    );
    let second = store
        .link_page(
            &local.space_id,
            prefix,
            first.last().map(LinkPosition::from).as_ref(),
            limit,
        )
        .await
        .unwrap();
    assert_eq!(
        second.iter().map(|row| row.link_ord).collect::<Vec<_>>(),
        [3]
    );
    let lookup = CandidateQuery {
        space: &local.space_id,
        folder: -1,
        leaf: "earlier-name",
        min_tier: 20,
        max_tier: 20,
        exact_note: None,
    };
    assert_eq!(
        store.candidates(lookup, None, 1).await.unwrap(),
        [candidate]
    );
    let checkpoint = TrustedCheckpoint {
        space_id: local.space_id.clone(),
        history_incarnation: local.incarnation,
        seq: seq(10),
        format_version: 1,
        platform_abi: "test".to_owned(),
        publication_id: "test".to_owned(),
        size_bytes: 23,
        digest: ContentDigest::from_bytes([42; 32]),
        graph_seq: SpaceSeq::ZERO,
    };
    store.register_checkpoint(&checkpoint).await.unwrap();
    assert_eq!(
        store
            .latest_trusted_checkpoint(&local, seq(10))
            .await
            .unwrap(),
        Some(checkpoint.clone())
    );

    store
        .apply(&SpaceApply {
            expected: Some(seq(10)),
            watermark: water(&local, seq(11)),
            mutations: vec![
                DerivedMutation::UpsertNote(Box::new(note(&local, "Second", 11))),
                DerivedMutation::UpsertFolder(folder(&local, None)),
                DerivedMutation::UpsertNote(Box::new(note(&local, "Third", 11))),
            ],
        })
        .await
        .expect("publish update");
    assert!(
        store
            .hydrate_current_cards(&local, seq(10), &[1])
            .await
            .unwrap()
            .is_none()
    );
    // Lock-free current-cut reads return CursorStale when derived has moved past
    // the requested cut.
    assert_eq!(
        store.note_by_id(&local, seq(10), &note_id()).await,
        Err(super::stale())
    );
    assert_eq!(
        store
            .note_by_id(&local, seq(11), &note_id())
            .await
            .unwrap()
            .unwrap()
            .title,
        "Third"
    );
    assert!(
        store
            .folder_by_id(&local, seq(11), &root_folder())
            .await
            .unwrap()
            .unwrap()
            .cover_note_id
            .is_none()
    );

    let encrypted = ProjectedNote {
        doc_class: DocClass::EncryptedNote,
        ..note(&local, "Must reject", 12)
    };
    assert!(
        store
            .apply(&SpaceApply {
                expected: Some(seq(11)),
                watermark: water(&local, seq(12)),
                mutations: vec![DerivedMutation::UpsertNote(Box::new(encrypted))],
            })
            .await
            .is_err()
    );
    let current = store.watermarks(&local.space_id).await.unwrap().unwrap();
    assert_eq!(current.projected_seq, seq(11));

    let pending = StageKey {
        scope: source.clone(),
        first: seq(1),
        last: seq(1),
    };
    let future = [DerivedMutation::UpsertChatRef(chat_ref(&source, &local, 1))];
    store.stage_page(&pending, 0, &future).await.unwrap();
    store
        .apply(&SpaceApply {
            expected: None,
            watermark: water(&source, seq(1)),
            mutations: vec![
                DerivedMutation::UpsertChatRef(chat_ref(&source, &local, 7)),
                DerivedMutation::UpsertChatRef(chat_ref(&source, &local, 2)),
            ],
        })
        .await
        .unwrap();
    let refs = store
        .chat_ref_page(&local, &note_id(), None, PageLimit::new(10).unwrap())
        .await
        .unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].ref_ordinal, 2);

    let stale_stage = StageKey {
        scope: local.clone(),
        first: seq(12),
        last: seq(12),
    };
    let references_to_erased_note = vec![
        DerivedMutation::UpsertFolder(folder(&local, Some(note_id()))),
        DerivedMutation::UpsertNoteAlias(ProjectedNoteAlias {
            space_id: local.space_id.clone(),
            old_parent_folder_id: root_folder(),
            old_slug_fold: "old".to_owned(),
            old_title_norm: "old title".to_owned(),
            created_seq: seq(12),
            target_note_id: note_id(),
        }),
        DerivedMutation::UpsertCandidate(CandidateLookupKey {
            space_id: local.space_id.clone(),
            tier: 2,
            scope_folder_dense_id: 0,
            leaf_norm_key: "old".to_owned(),
            target_dense_id: 1,
            target_note_id: note_id(),
            created_at_sec: 0,
            created_at_nsec: 0,
        }),
    ];
    store
        .stage_page(&stale_stage, 0, &references_to_erased_note)
        .await
        .unwrap();
    store
        .erase_visibility(&local, seq(15), &[note_id()], &[])
        .await
        .unwrap();
    assert_eq!(
        store
            .stage_page(&stale_stage, 0, &references_to_erased_note)
            .await,
        Err(super::stale()),
    );
    assert_eq!(
        store
            .publish_staged(&stale_stage, 0, &water(&local, seq(12)), Some(seq(11)))
            .await,
        Err(super::stale()),
    );
    assert_eq!(
        store
            .apply(&SpaceApply {
                expected: Some(seq(11)),
                watermark: water(&local, seq(12)),
                mutations: references_to_erased_note,
            })
            .await,
        Err(super::stale()),
    );
    for table in ["projected_note_aliases", "candidate_lookup_keys"] {
        let sql = format!(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM {table} WHERE space_id = ? AND target_note_id = ?"
        );
        let args = vec![
            super::sql::value(&local.space_id),
            super::sql::value(&note_id()),
        ];
        let count = store
            .database
            .read(move |mut tx| {
                Box::pin(async move { tx.select(&sql, args, &[Kind::Integer]).await })
            })
            .await
            .unwrap();
        assert_eq!(count, [vec![super::sql::value(&0i64)]]);
    }
    let mut outdated_base = water(&local, seq(15));
    outdated_base.snapshot_seq = seq(10);
    assert_eq!(
        store
            .apply(&SpaceApply {
                expected: Some(seq(11)),
                watermark: outdated_base,
                mutations: Vec::new(),
            })
            .await,
        Err(super::stale()),
    );
    assert!(
        store
            .note_by_id(&local, seq(11), &note_id())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .latest_trusted_checkpoint(&local, seq(10))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.register_checkpoint(&checkpoint).await,
        Err(super::stale())
    );
    assert!(
        store
            .folder_by_id(&local, seq(11), &root_folder())
            .await
            .unwrap()
            .unwrap()
            .cover_note_id
            .is_none()
    );
    assert!(
        store
            .chat_ref_page(&local, &note_id(), None, PageLimit::new(10).unwrap())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.stage_page(&pending, 0, &future).await,
        Err(super::stale())
    );
    assert_eq!(
        store
            .publish_staged(&pending, 1, &water(&source, seq(1)), Some(seq(1)))
            .await,
        Err(super::stale()),
    );

    let restored = scope(1, 4);
    let obsolete = store.observe_seed(&local.space_id).await.unwrap();
    let cancelled = Cancellation::default();
    cancelled.cancel();
    let interrupted = store.observe_seed(&restored.space_id).await.unwrap();
    assert!(matches!(
        store
            .begin_seed(&water(&restored, seq(3)), interrupted, &cancelled)
            .await,
        Err(PortError::Cancelled(_)),
    ));
    assert_eq!(
        store
            .watermarks(&local.space_id)
            .await
            .unwrap()
            .unwrap()
            .scope,
        local,
    );
    let current = store.observe_seed(&restored.space_id).await.unwrap();
    store
        .begin_seed(&water(&restored, seq(3)), current, &Cancellation::default())
        .await
        .unwrap();

    // The old worker had already read an exact canonical header when a
    // replacement history won admission. Its prepared seed may not rebind.
    assert_eq!(
        store
            .begin_seed(&water(&local, seq(17)), obsolete, &Cancellation::default())
            .await,
        Err(super::stale()),
    );
    assert_eq!(
        store
            .watermarks(&local.space_id)
            .await
            .unwrap()
            .unwrap()
            .scope,
        restored
    );
    assert_eq!(
        store.hydrate(&local, seq(11), &[1]).await,
        Err(DomainError::validation(ValidationReason::HistoryIncarnationMismatch).into()),
    );
}

async fn test_control(control: &GenerationControl) {
    let first = GenerationDescriptor {
        generation: ProjectionGeneration::new(1).unwrap(),
        publication_epoch: 1,
        cut_fingerprint: ContentDigest::from_bytes([11; 32]),
    };
    let next = GenerationDescriptor {
        generation: ProjectionGeneration::new(2).unwrap(),
        publication_epoch: 2,
        cut_fingerprint: ContentDigest::from_bytes([22; 32]),
    };
    let alternate = GenerationDescriptor {
        generation: ProjectionGeneration::new(3).unwrap(),
        publication_epoch: 2,
        cut_fingerprint: ContentDigest::from_bytes([33; 32]),
    };
    assert!(control.active().await.unwrap().is_none());
    assert!(control.compare_and_swap(None, &first).await.unwrap());
    assert!(!control.compare_and_swap(Some(&first), &next).await.unwrap());
    assert!(
        !control
            .generation_reclaimable(first.generation)
            .await
            .unwrap()
    );
    let (a, b) = tokio::join!(
        control.reserve_candidate(Some(&first), &next),
        control.reserve_candidate(Some(&first), &alternate),
    );
    assert_ne!(a.unwrap(), b.unwrap());
    assert_eq!(control.active().await.unwrap(), Some(first.clone()));
    let candidate = control.candidate().await.unwrap().unwrap();
    assert!(
        !control
            .generation_reclaimable(candidate.generation)
            .await
            .unwrap()
    );
    assert!(
        control
            .compare_and_swap(Some(&first), &candidate)
            .await
            .unwrap()
    );
    assert_eq!(control.active().await.unwrap(), Some(candidate));
    assert!(control.candidate().await.unwrap().is_none());
    assert!(
        control
            .generation_reclaimable(first.generation)
            .await
            .unwrap()
    );
}

async fn test_short_reads(store: &DerivedStore) {
    let started = Instant::now();
    let held = store
        .database
        .read(|mut tx| {
            Box::pin(async move {
                let sql = if tx.postgres() {
                    "SELECT CAST(1 AS BIGINT) FROM pg_sleep(2)"
                } else {
                    "WITH RECURSIVE counter(n) AS (
                VALUES (0) UNION ALL SELECT n + 1 FROM counter WHERE n < 20000000
             ) SELECT MAX(n) FROM counter"
                };
                tx.select(sql, Vec::new(), &[Kind::Integer]).await?;
                Ok(())
            })
        })
        .await;
    assert!(matches!(held, Err(PortError::DeadlineExceeded(_))));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(
        store
            .watermarks(&scope(99, 1).space_id)
            .await
            .expect("reader reuse")
            .is_none()
    );
}

#[test]
fn schema_prefix_respects_postgres_identifier_budget() {
    assert!(validate_schema_prefix(&"a".repeat(42)).is_ok());
    assert!(validate_schema_prefix(&"a".repeat(43)).is_err());
    assert!(validate_schema_prefix("").is_err());
    assert!(validate_schema_prefix("bad-prefix").is_err());
}

#[tokio::test]
async fn sqlite_projection_state_and_short_reads() {
    let scratch = Scratch::new();
    let generation = ProjectionGeneration::new(1).unwrap();
    let store = DerivedStore::open_sqlite(&scratch.data(), generation)
        .await
        .unwrap();
    test_storage(&store).await;
    test_trashed_and_active_folder_path_uniqueness(&store).await;
    test_replay_publication(&store).await;
    test_short_reads(&store).await;
    let control = GenerationControl::open_sqlite(&scratch.data())
        .await
        .unwrap();
    test_control(&control).await;
    let reopened = GenerationControl::open_sqlite(&scratch.data())
        .await
        .unwrap();
    assert_eq!(
        reopened.active().await.unwrap(),
        control.active().await.unwrap()
    );
    drop(store);
    let reopened = DerivedStore::open_sqlite(&scratch.data(), generation)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .watermarks(&scope(1, 4).space_id)
            .await
            .unwrap()
            .unwrap()
            .scope,
        scope(1, 4)
    );
}

#[derive(Deserialize)]
struct PgFixture {
    pg_socket_dir_container: PathBuf,
    pg_socket_dir_host: PathBuf,
    pg_port: u16,
    pg_user: String,
    pg_password: String,
    pg_database: String,
}

async fn postgres_fixture() -> PgPool {
    let manifest = std::env::var_os("NOTARIUM_STORAGE_FIXTURES_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../.artifacts/storage-tests/current.json")
        });
    let manifest = fs::read(manifest)
        .expect("PostgreSQL 16 fixture missing, run the canonical make test target");
    let fixture: PgFixture = serde_json::from_slice(&manifest).expect("storage fixture manifest");
    let socket_name = format!(".s.PGSQL.{}", fixture.pg_port);
    let socket = [fixture.pg_socket_dir_container, fixture.pg_socket_dir_host]
        .into_iter()
        .find(|directory| directory.join(&socket_name).exists())
        .expect("PostgreSQL fixture socket");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(
            PgConnectOptions::new()
                .socket(socket)
                .port(fixture.pg_port)
                .username(&fixture.pg_user)
                .password(&fixture.pg_password)
                .database(&fixture.pg_database)
                .ssl_mode(PgSslMode::Disable),
        )
        .await
        .expect("PostgreSQL fixture pool")
}

#[tokio::test]
async fn postgres_projection_state_and_short_reads() {
    let pool = postgres_fixture().await;
    let prefix = format!("t_{}_d", random_label());
    let store =
        DerivedStore::open_postgres(pool.clone(), &prefix, ProjectionGeneration::new(1).unwrap())
            .await
            .unwrap();
    test_storage(&store).await;
    test_trashed_and_active_folder_path_uniqueness(&store).await;
    test_postgres_seed_batches(&store).await;
    test_replay_publication(&store).await;
    test_short_reads(&store).await;
    let control = GenerationControl::open_postgres(pool.clone(), &prefix)
        .await
        .unwrap();
    test_control(&control).await;
    drop(store);
    // Recreating a dropped generation schema on the same pooled connection must
    // remain readable (no stale sqlx prepared statement failures across DDL).
    let recreate = format!("DROP SCHEMA \"{prefix}_g1\" CASCADE;");
    sqlx::raw_sql(AssertSqlSafe(recreate.as_str()))
        .execute(&pool)
        .await
        .expect("drop g1 before rebuild on same pool");
    let rebuilt =
        DerivedStore::open_postgres(pool.clone(), &prefix, ProjectionGeneration::new(1).unwrap())
            .await
            .unwrap();
    let h = scope(0xe1, 0xe2);
    rebuilt
        .apply(&SpaceApply {
            expected: None,
            watermark: water(&h, seq(1)),
            mutations: vec![
                DerivedMutation::UpsertFolder(folder(&h, None)),
                DerivedMutation::UpsertNote(Box::new(note(&h, "Rebuilt", 1))),
            ],
        })
        .await
        .unwrap();
    assert_eq!(rebuilt.hydrate(&h, seq(1), &[1]).await.unwrap().len(), 1);
    assert!(
        rebuilt
            .folder_by_path(&h, seq(1), "")
            .await
            .unwrap()
            .is_some()
    );
    drop(rebuilt);
    let cleanup =
        format!("DROP SCHEMA \"{prefix}_g1\" CASCADE; DROP SCHEMA \"{prefix}_ctrl\" CASCADE;");
    sqlx::raw_sql(AssertSqlSafe(cleanup.as_str()))
        .execute(&pool)
        .await
        .expect("drop derived fixture schemas");
    pool.close().await;
}

async fn test_postgres_seed_batches(store: &DerivedStore) {
    let history = scope(0x87, 0x88);
    let mut next = water(&history, seq(10));
    next.next_dense_id = 3;
    let witness = store.observe_seed(&history.space_id).await.unwrap();
    store
        .begin_seed(&next, witness, &Cancellation::default())
        .await
        .unwrap();
    let key = StageKey {
        scope: history.clone(),
        first: SpaceSeq::ZERO,
        last: next.projected_seq,
    };
    let mut other = note(&history, "Other", 10);
    other.dense_id = 0;
    other.note_id = NoteId::from_bytes([0x89; 16]);
    let mut blocked = note(&history, "Blocked", 10);
    blocked.dense_id = 2;
    blocked.note_id = NoteId::from_bytes([0x8a; 16]);
    let link = ProjectedLink {
        space_id: history.space_id.clone(),
        src_dense_id: 1,
        link_ord: 0,
        src_folder_id: root_folder(),
        raw_target: "other".into(),
        target_kind_tag: 0,
        dir_norm_prefix: String::new(),
        leaf_norm_key: "other".into(),
        uses_relative_prefix: false,
        resolved_dense_id: None,
        resolved_tier: None,
    };
    let resolved = ProjectedLink {
        resolved_dense_id: Some(0),
        resolved_tier: Some(1),
        ..link.clone()
    };
    let first_page = [
        DerivedMutation::UpsertNote(Box::new(note(&history, "First", 10))),
        DerivedMutation::UpsertLink(link),
        DerivedMutation::UpsertNote(Box::new(other.clone())),
        DerivedMutation::DeleteDescriptors(note_id()),
        DerivedMutation::UpsertNote(Box::new(note(&history, "Last", 11))),
        DerivedMutation::UpsertLink(resolved.clone()),
    ];
    let blocked_id = blocked.note_id.clone();
    let second_page = [DerivedMutation::UpsertNote(Box::new(blocked))];
    store.stage_page(&key, 0, &first_page).await.unwrap();
    store.stage_page(&key, 1, &second_page).await.unwrap();
    let space = history.clone();
    // Install only the purge witness so both private pages remain available.
    // Physical cleanup also deletes the blocked page.
    store
        .database
        .write(false, move |mut tx| {
            Box::pin(async move {
                tx.execute(
                    "INSERT INTO projected_purge_markers (space_id, history_incarnation, note_id)
                     VALUES (?, ?, ?)",
                    vec![
                        value(&space.space_id),
                        value(&space.incarnation),
                        value(&blocked_id),
                    ],
                )
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert_eq!(
        store.stage_page(&key, 1, &second_page).await,
        Err(super::stale())
    );
    assert_eq!(
        store
            .publish_staged(&key, 2, &next, Some(SpaceSeq::ZERO))
            .await,
        Err(super::stale())
    );
    let id = history.space_id.clone();
    let count = store
        .database
        .read(move |mut tx| {
            Box::pin(async move {
                tx.select(
                    "SELECT COUNT(*) FROM projected_notes WHERE space_id = ?",
                    vec![value(&id)],
                    &[Kind::Integer],
                )
                .await
            })
        })
        .await
        .unwrap();
    assert_eq!(count, vec![vec![value(&0i64)]]);
    assert!(
        store
            .watermarks(&history.space_id)
            .await
            .unwrap()
            .unwrap()
            .seed_in_progress
    );

    store.discard_staging(&history).await.unwrap();
    store.stage_page(&key, 0, &first_page).await.unwrap();
    store
        .publish_staged(&key, 1, &next, Some(SpaceSeq::ZERO))
        .await
        .unwrap();
    assert_eq!(
        store.hydrate(&history, seq(10), &[0, 1, 2]).await.unwrap(),
        [Some(other), Some(note(&history, "Last", 11)), None]
    );
    let links = store
        .link_page_at(
            &history,
            seq(10),
            LinkAddress::Source(1),
            None,
            PageLimit::new(2).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(links, [resolved]);
}
