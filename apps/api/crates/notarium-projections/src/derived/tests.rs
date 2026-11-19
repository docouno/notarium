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
    LinkAddress, LinkPosition, LinkScratch, ProjectedChatRef, ProjectedFolder, ProjectedLink,
    ProjectedNote, ProjectedNoteAlias, ProjectionWatermark, ScratchSource, SpaceApply, StageKey,
    TrustedCheckpoint,
    records::encode,
    sql::{Kind, value},
    write::prune_history_budget,
};
use crate::links::{AliasKey, CandidateQuery, ResolutionIndex};

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

async fn page_pin_regression(store: &DerivedStore) {
    let history = scope(0xd0, 0xd1);
    let publish = |expected, seq_no, title| SpaceApply {
        expected,
        watermark: water(&history, seq(seq_no)),
        mutations: vec![DerivedMutation::UpsertNote(Box::new(note(
            &history,
            title,
            seq_no as u8,
        )))],
    };
    store
        .apply(&publish(None, 10, "Chosen but unpinned"))
        .await
        .unwrap();
    store
        .apply(&publish(Some(seq(10)), 11, "Fresh published cut"))
        .await
        .unwrap();
    let budget = Duration::from_secs(5);
    let gap = store
        .pin_open(&history, seq(10), Duration::from_secs(30), budget)
        .await;
    assert!(matches!(
        gap,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::CursorStale
    ));
    let (cursor, page) = store
        .pin_open(&history, seq(11), Duration::from_secs(30), budget)
        .await
        .unwrap();
    store
        .apply(&publish(Some(seq(11)), 12, "Routine promotion"))
        .await
        .unwrap();

    let pinned = history.clone();
    let admission = store.page_admission.clone();
    let pressure = store
        .database
        .write(false, move |mut tx| {
            Box::pin(async move {
                let (guard, _) =
                    super::schema::lock_space_guard_with_origin(&mut tx, &pinned).await?;
                assert_eq!(guard.incarnation, pinned.incarnation);
                prune_history_budget(&mut tx, &pinned, seq(13), seq(11), 0, &admission).await
            })
        })
        .await;
    assert!(matches!(pressure, Err(PortError::Unavailable(_))));
    assert!(matches!(
        store.pin_cut(&history, seq(12), budget).await,
        Err(PortError::Unavailable(_)),
    ));
    cursor
        .check()
        .await
        .expect("pressure rolls back the failed promotion");

    let expired = history.space_id.clone();
    store
        .database
        .write(false, move |mut tx| {
            Box::pin(async move {
                tx.execute(
                    "UPDATE projection_cut_leases SET expires_at_ms = 0 WHERE space_id = ?",
                    vec![value(&expired)],
                )
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        cursor.pin_page(budget).await.is_err(),
        "an expired cursor cannot start another page"
    );
    store
        .apply(&publish(
            Some(seq(12)),
            13,
            "Promote with only the page pinned",
        ))
        .await
        .unwrap();
    drop(
        store
            .pin_cut(&history, seq(13), budget)
            .await
            .expect("promotion reopens admission"),
    );
    let retained = page
        .run(store.note_by_id(&history, seq(11), &note_id()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.title, "Fresh published cut");

    let space = history.space_id.clone();
    drop(page);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let space = space.clone();
            let pins = store
                .database
                .read(move |mut tx| {
                    Box::pin(async move {
                        tx.select(
                            "SELECT CAST(1 AS BIGINT) FROM projection_page_pins WHERE space_id = ? LIMIT 1",
                            vec![value(&space)],
                            &[Kind::Integer],
                        )
                        .await
                    })
                })
                .await
                .unwrap();
            if pins.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("completed page releases its protection");
    store
        .apply(&publish(Some(seq(13)), 14, "Prune after release"))
        .await
        .unwrap();
    assert!(
        store
            .note_by_id(&history, seq(11), &note_id())
            .await
            .is_err()
    );
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
        norm_path_prefix: String::new(),
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
        start_byte: ordinal * 10,
        end_byte: ordinal * 10 + 10,
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

    store
        .publish_staged_with_replay(&key, 0, &next, Some(seq(5)), Some(slots.clone()))
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
    let scratch_key = StageKey {
        scope: local.clone(),
        first: seq(11),
        last: seq(11),
    };
    let scratch = LinkScratch::open(store, &scratch_key, seq(10))
        .await
        .unwrap();
    assert!(scratch.first_note(&note_id()).await.unwrap());
    assert!(!scratch.first_note(&note_id()).await.unwrap());
    scratch
        .record_source(ScratchSource {
            dense: 1,
            note: note_id(),
            parent: Some(root_folder()),
            visible: true,
            raw_count: Some(1),
            replace_candidates: true,
            replace_slot: true,
            slot: Some((root_folder(), "later-name".into())),
        })
        .await
        .unwrap();
    scratch
        .record_raw(1, 0, &["staged-body".into()])
        .await
        .unwrap();
    let later = CandidateLookupKey {
        leaf_norm_key: "later-name".into(),
        ..candidate.clone()
    };
    scratch
        .record_candidates(std::slice::from_ref(&later))
        .await
        .unwrap();
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
    assert!(
        scratch
            .candidates(lookup, None, 1)
            .await
            .unwrap()
            .is_empty()
    );
    let revised = CandidateQuery {
        leaf: "later-name",
        ..lookup
    };
    assert_eq!(scratch.candidates(revised, None, 1).await.unwrap(), [later]);
    assert_eq!(
        scratch
            .slot_occupant(&local.space_id, &root_folder(), "later-name")
            .await
            .unwrap(),
        Some(note_id())
    );
    let alias = ProjectedNoteAlias {
        space_id: local.space_id.clone(),
        old_parent_folder_id: root_folder(),
        old_slug_fold: "earlier-name".into(),
        old_title_norm: "earlier title".into(),
        created_seq: seq(11),
        target_note_id: note_id(),
    };
    scratch.record_alias(&alias).await.unwrap();
    assert_eq!(
        scratch
            .aliases(&local.space_id, AliasKey::Title, "earlier title", None, 20)
            .await
            .unwrap(),
        [alias]
    );
    assert_eq!(
        scratch.raw(1, 0).await.unwrap(),
        [(0, "staged-body".into())]
    );
    scratch.record_watch(&first).await.unwrap();
    scratch.record_watch(&first).await.unwrap();
    assert!(scratch.watched(None).await.unwrap().is_empty());
    store.discard_staging(&local).await.unwrap();
    assert!(scratch.raw(1, 0).await.is_err());
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

    let lease = store
        .retain_cut(&local, seq(10), Duration::from_secs(10))
        .await
        .unwrap();
    store
        .apply(&SpaceApply {
            expected: Some(seq(10)),
            watermark: water(&local, seq(11)),
            mutations: vec![
                DerivedMutation::UpsertNote(Box::new(note(&local, "Second", 11))),
                DerivedMutation::UpsertFolder(folder(&local, None)),
                // Before-images capture the command entry once, even for one key
                // updated more than once within a command.
                DerivedMutation::UpsertNote(Box::new(note(&local, "Third", 11))),
            ],
        })
        .await
        .expect("publish update");
    lease.check().await.unwrap();
    assert!(
        store
            .hydrate_current_cards(&local, seq(10), &[1])
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .note_by_id(&local, seq(10), &note_id())
            .await
            .unwrap()
            .unwrap()
            .title,
        "First"
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
    assert_eq!(
        store
            .folder_by_id(&local, seq(10), &root_folder())
            .await
            .unwrap()
            .unwrap()
            .cover_note_id,
        Some(note_id())
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
    assert_eq!(lease.check().await, Err(super::stale()));
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

async fn test_control(control: &GenerationControl, peer: Option<&GenerationControl>) {
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
    let (a, b) = tokio::join!(
        control.reserve_candidate(Some(&first), &next),
        control.reserve_candidate(Some(&first), &alternate),
    );
    assert_ne!(a.unwrap(), b.unwrap());
    assert_eq!(control.active().await.unwrap(), Some(first.clone()));
    let candidate = control.candidate().await.unwrap().unwrap();
    if let Some(peer) = peer {
        test_peer_handoff(control, peer, &first, &candidate).await;
    } else {
        assert!(
            control
                .compare_and_swap(Some(&first), &candidate)
                .await
                .unwrap()
        );
    }
    assert_eq!(control.active().await.unwrap(), Some(candidate));
    assert!(control.candidate().await.unwrap().is_none());
}

async fn test_peer_handoff(
    control: &GenerationControl,
    peer: &GenerationControl,
    first: &GenerationDescriptor,
    next: &GenerationDescriptor,
) {
    use super::SpaceGenerationWitness;

    let old = control
        .admit_generation_read(first.generation, "owner-a")
        .await
        .unwrap();
    let attempt = peer.peer_candidate().await.unwrap().unwrap();
    let a = SpaceGenerationWitness {
        scope: scope(1, 10),
        through: seq(4),
        owner_epoch: LeaseEpoch::new(1).unwrap(),
        participant: "owner-a".to_owned(),
        checkpoint_digest: ContentDigest::from_bytes([30; 32]),
    };
    let b = SpaceGenerationWitness {
        scope: scope(2, 10),
        through: seq(7),
        owner_epoch: LeaseEpoch::new(2).unwrap(),
        participant: "owner-b".to_owned(),
        checkpoint_digest: ContentDigest::from_bytes([31; 32]),
    };
    control
        .record_peer_readiness(&attempt, std::slice::from_ref(&a))
        .await
        .unwrap();
    peer.record_peer_readiness(&attempt, std::slice::from_ref(&b))
        .await
        .unwrap();
    let ready = peer.peer_readiness(&attempt).await.unwrap();
    assert_eq!(ready.len(), 2);
    let proposal = control
        .propose_peer_cutover(&attempt, ready, Duration::from_millis(500))
        .await
        .unwrap()
        .expect("both peers are ready");
    let _a_ack = control
        .acknowledge_peer_cutover(&proposal, &[a])
        .await
        .unwrap()
        .expect("first peer frozen");
    assert!(
        !control
            .commit_peer_cutover(first, next, &proposal)
            .await
            .unwrap()
    );
    assert_eq!(peer.active().await.unwrap().as_ref(), Some(first));
    let b_ack = peer
        .acknowledge_peer_cutover(&proposal, std::slice::from_ref(&b))
        .await
        .unwrap()
        .expect("second peer frozen");
    assert!(control.all_peers_acknowledged(&proposal).await.unwrap());
    b_ack.release().await.unwrap();
    assert!(
        !control
            .commit_peer_cutover(first, next, &proposal)
            .await
            .unwrap()
    );
    let _b_ack = peer
        .acknowledge_peer_cutover(&proposal, &[b])
        .await
        .unwrap()
        .expect("second peer refrozen");
    assert!(
        control
            .commit_peer_cutover(first, next, &proposal)
            .await
            .unwrap()
    );
    assert!(!peer.generation_reclaimable(first.generation).await.unwrap());
    assert!(
        matches!(peer.admit_generation_read(first.generation, "owner-b").await,
        Err(error) if error == super::stale())
    );
    drop(old);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !peer.generation_reclaimable(first.generation).await.unwrap() {
        assert!(
            Instant::now() < deadline,
            "retained generation lease released"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn test_oversized_staging(store: &DerivedStore) {
    use super::staging::MAX_STAGE_BYTES;

    let local = scope(0xc3, 0xc4);
    let initial = water(&local, seq(10));
    store
        .apply(&SpaceApply {
            expected: None,
            watermark: initial.clone(),
            mutations: vec![DerivedMutation::UpsertFolder(folder(&local, None))],
        })
        .await
        .unwrap();
    let key = StageKey {
        scope: local.clone(),
        first: seq(11),
        last: seq(11),
    };
    let mut row = note(&local, "Fragmented", 11);
    row.view_blocks_msgpack = vec![0xe7; MAX_STAGE_BYTES + 41];
    let large = [DerivedMutation::UpsertNote(Box::new(row.clone()))];
    store.stage_page(&key, 0, &large).await.unwrap();
    store.stage_page(&key, 0, &large).await.unwrap();
    assert_eq!(fragment_sizes(store, &local).await.len(), 2);

    let scope = local.clone();
    store
        .database
        .write(false, move |mut tx| {
            Box::pin(async move {
                tx.execute(
                    "DELETE FROM projection_apply_page_fragments
                  WHERE space_id = ? AND fragment_no = 1",
                    vec![value(&scope.space_id)],
                )
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let next = water(&local, seq(11));
    assert!(
        store
            .publish_staged(&key, 1, &next, Some(seq(10)))
            .await
            .is_err(),
        "a page witness without its final fragment must not publish"
    );
    assert_eq!(
        store.watermarks(&local.space_id).await.unwrap(),
        Some(initial)
    );
    assert!(
        store
            .note_by_id(&local, seq(10), &row.note_id)
            .await
            .unwrap()
            .is_none()
    );

    store.discard_staging(&local).await.unwrap();
    assert!(fragment_sizes(store, &local).await.is_empty());
    store.stage_page(&key, 0, &large).await.unwrap();
    let sizes = fragment_sizes(store, &local).await;
    assert_eq!(sizes[0], MAX_STAGE_BYTES as u64);
    assert!(sizes[1] > 41 && sizes[1] < MAX_STAGE_BYTES as u64);
    store
        .publish_staged(&key, 1, &next, Some(seq(10)))
        .await
        .unwrap();
    assert_eq!(
        store
            .note_by_id(&local, seq(11), &row.note_id)
            .await
            .unwrap(),
        Some(row)
    );
    assert!(fragment_sizes(store, &local).await.is_empty());

    let obsolete = StageKey {
        scope: local.clone(),
        first: seq(12),
        last: seq(12),
    };
    store.stage_page(&obsolete, 0, &large).await.unwrap();
    store
        .erase_visibility(&local, seq(13), &[note_id()], &[])
        .await
        .unwrap();
    assert!(fragment_sizes(store, &local).await.is_empty());
    assert_eq!(
        store.stage_page(&obsolete, 0, &large).await,
        Err(super::stale())
    );
}

async fn fragment_sizes(store: &DerivedStore, scope: &HistoryScope) -> Vec<u64> {
    let space = scope.space_id.clone();
    store
        .database
        .read(move |mut tx| {
            Box::pin(async move {
                tx.select(
                    "SELECT CAST(length(payload) AS BIGINT)
                   FROM projection_apply_page_fragments WHERE space_id = ? ORDER BY fragment_no",
                    vec![value(&space)],
                    &[Kind::Integer],
                )
                .await?
                .into_iter()
                .map(|mut row| {
                    <u64 as super::sql::SqlColumn>::read(row.pop().ok_or_else(super::invalid_row)?)
                })
                .collect()
            })
        })
        .await
        .unwrap()
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

#[tokio::test]
async fn sqlite_projection_state_and_short_reads() {
    let scratch = Scratch::new();
    let generation = ProjectionGeneration::new(1).unwrap();
    let store = DerivedStore::open_sqlite(&scratch.data(), generation)
        .await
        .unwrap();
    test_storage(&store).await;
    test_oversized_staging(&store).await;
    page_pin_regression(&store).await;
    test_replay_publication(&store).await;
    test_short_reads(&store).await;
    let control = GenerationControl::open_sqlite(&scratch.data())
        .await
        .unwrap();
    test_control(&control, None).await;
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
    test_postgres_seed_batches(&store).await;
    test_oversized_staging(&store).await;
    page_pin_regression(&store).await;
    test_replay_publication(&store).await;
    test_short_reads(&store).await;
    let control = GenerationControl::open_postgres(pool.clone(), &prefix)
        .await
        .unwrap();
    let peer_pool = postgres_fixture().await;
    let peer = GenerationControl::open_postgres(peer_pool.clone(), &prefix)
        .await
        .unwrap();
    test_control(&control, Some(&peer)).await;
    let cleanup =
        format!("DROP SCHEMA \"{prefix}_g1\" CASCADE; DROP SCHEMA \"{prefix}_ctrl\" CASCADE;");
    sqlx::raw_sql(AssertSqlSafe(cleanup.as_str()))
        .execute(&pool)
        .await
        .expect("drop derived fixture schemas");
    pool.close().await;
    peer_pool.close().await;
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

#[tokio::test]
async fn postgres_abandoned_admission_and_off_thread_release_retry() {
    const COMMIT_BLOCKER: i64 = 1_760_020;
    let pool = postgres_fixture().await;
    let prefix = format!("t_{}_lease", random_label());
    let schema = format!("{prefix}_ctrl");
    let control = GenerationControl::open_postgres(pool.clone(), &prefix)
        .await
        .unwrap();
    let active = GenerationDescriptor {
        generation: ProjectionGeneration::new(1).unwrap(),
        publication_epoch: 1,
        cut_fingerprint: ContentDigest::from_bytes([35; 32]),
    };
    assert!(control.compare_and_swap(None, &active).await.unwrap());

    let fixtures = format!(
        r#"
        CREATE TABLE "{schema}".lease_commit_witness (id BYTEA PRIMARY KEY);
        CREATE FUNCTION "{schema}".observe_lease_commit() RETURNS trigger
        LANGUAGE plpgsql AS $function$
        BEGIN
            IF NEW.participant = 'abandoned-open' THEN
                PERFORM pg_advisory_xact_lock({COMMIT_BLOCKER});
                INSERT INTO "{schema}".lease_commit_witness VALUES (NEW.lease_id);
            END IF;
            RETURN NULL;
        END;
        $function$;
        CREATE CONSTRAINT TRIGGER observe_lease_commit
          AFTER INSERT ON "{schema}".projection_generation_read_leases
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          EXECUTE FUNCTION "{schema}".observe_lease_commit();
        CREATE SEQUENCE "{schema}".lease_release_attempt;
        CREATE FUNCTION "{schema}".retry_lease_release() RETURNS trigger
        LANGUAGE plpgsql AS $function$
        BEGIN
            IF OLD.participant = 'off-thread-release' THEN
                IF nextval('"{schema}".lease_release_attempt') = 1 THEN
                    RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'fixture transient release failure';
                END IF;
            END IF;
            RETURN OLD;
        END;
        $function$;
        CREATE TRIGGER retry_lease_release
          BEFORE DELETE ON "{schema}".projection_generation_read_leases
          FOR EACH ROW EXECUTE FUNCTION "{schema}".retry_lease_release();
        "#
    );
    sqlx::raw_sql(AssertSqlSafe(fixtures.as_str()))
        .execute(&pool)
        .await
        .unwrap();

    let mut blocker = pool.acquire().await.unwrap();
    blocker.close_on_drop();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(COMMIT_BLOCKER)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let request_control = control.clone();
    let generation = active.generation;
    let request = tokio::spawn(async move {
        request_control
            .admit_generation_read(generation, "abandoned-open")
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_locks
                   WHERE locktype = 'advisory' AND classid = 0 AND objid = CAST($1 AS BIGINT)::oid
                     AND objsubid = 1 AND NOT granted)",
            )
            .bind(COMMIT_BLOCKER)
            .fetch_one(&pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("registration reached its deferred COMMIT trigger");
    request.abort();
    assert!(matches!(request.await, Err(error) if error.is_cancelled()));
    let unlocked: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1)")
        .bind(COMMIT_BLOCKER)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    assert!(unlocked);
    drop(blocker);

    let committed = format!(r#"SELECT EXISTS (SELECT 1 FROM "{schema}".lease_commit_witness)"#);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let committed: bool = sqlx::query_scalar(AssertSqlSafe(committed.as_str()))
                .fetch_one(&pool)
                .await
                .unwrap();
            if committed && !lease_row_exists(&pool, &schema, "abandoned-open").await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the abandoned registration committed and was then released");

    let held = control
        .admit_generation_read(generation, "off-thread-release")
        .await
        .unwrap();
    assert!(lease_row_exists(&pool, &schema, "off-thread-release").await);
    let outside_owner = held.clone();
    std::thread::spawn(move || drop(held)).join().unwrap();
    assert!(lease_row_exists(&pool, &schema, "off-thread-release").await);
    std::thread::spawn(move || drop(outside_owner))
        .join()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while lease_row_exists(&pool, &schema, "off-thread-release").await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("release retried after a real transient PostgreSQL failure");
    let sequence = format!(r#"SELECT last_value FROM "{schema}".lease_release_attempt"#);
    let attempts: i64 = sqlx::query_scalar(AssertSqlSafe(sequence.as_str()))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(attempts >= 2);

    let ddl = format!(r#"DROP SCHEMA "{schema}" CASCADE"#);
    sqlx::raw_sql(AssertSqlSafe(ddl.as_str()))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

async fn lease_row_exists(pool: &PgPool, schema: &str, participant: &str) -> bool {
    let sql = format!(
        r#"SELECT EXISTS (SELECT 1 FROM "{schema}".projection_generation_read_leases WHERE participant = $1)"#
    );
    sqlx::query_scalar(AssertSqlSafe(sql.as_str()))
        .bind(participant)
        .fetch_one(pool)
        .await
        .unwrap()
}
